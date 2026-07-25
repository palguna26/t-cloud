import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { loadConfig } from "./config.js";
import { createDatabase, transaction, type Database } from "./db.js";
import { processStripeEvent } from "./billing.js";
import type Stripe from "stripe";

export interface Job {
  id: string;
  kind: string;
  workspace_id: string | null;
  payload_json: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function claimJob(db: Database, workerId: string): Promise<Job | null> {
  return transaction(db, async (client) => {
    const result = await client.query<Job>(`
      SELECT id, kind, workspace_id, payload_json, attempts, max_attempts
      FROM jobs
      WHERE (
        state IN ('pending', 'failed')
        OR (state = 'leased' AND lease_until <= now())
      ) AND next_run_at <= now()
      ORDER BY next_run_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    const job = result.rows[0];
    if (!job) return null;
    await client.query(`
      UPDATE jobs
      SET state = 'leased', leased_by = $1, lease_until = now() + interval '60 seconds',
          attempts = attempts + 1, updated_at = now()
      WHERE id = $2
    `, [workerId, job.id]);
    return { ...job, attempts: job.attempts + 1 };
  });
}

async function complete(client: pg.PoolClient, job: Job): Promise<void> {
  await client.query(`
    UPDATE jobs
    SET state = 'succeeded', leased_by = NULL, lease_until = NULL, updated_at = now()
    WHERE id = $1
  `, [job.id]);
}

async function fail(client: pg.PoolClient, job: Job, error: unknown): Promise<void> {
  const dead = job.attempts >= job.max_attempts;
  const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
  await client.query(`
    UPDATE jobs
    SET state = $2, leased_by = NULL, lease_until = NULL, last_error = $3,
        next_run_at = now() + ($4 * interval '1 second'), updated_at = now()
    WHERE id = $1
  `, [
    job.id,
    dead ? "dead" : "failed",
    error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
    delaySeconds,
  ]);
}

async function projectEvent(db: Database, job: Job): Promise<void> {
  const sourceEventId = job.payload_json["source_event_id"];
  if (typeof sourceEventId !== "string") throw new Error("project_event requires source_event_id");
  await transaction(db, async (client) => {
    const result = await client.query<{
      id: string;
      workspace_id: string;
      work_thread_id: string | null;
      agent_identity_id: string | null;
      agent_session_id: string | null;
      source: string;
      event_type: string;
      payload_text: string | null;
    }>(`
      SELECT id, workspace_id, work_thread_id, agent_identity_id,
        agent_session_id, source, event_type, payload_text
      FROM source_events WHERE id = $1
    `, [sourceEventId]);
    const event = result.rows[0];
    if (!event?.work_thread_id || !event.payload_text) return;
    const type = PROJECTED_TYPES[event.event_type];
    if (!type) return;

    const finalResponse = event.event_type === "session_ended";
    const projections = event.source === "slack"
      ? projectSlackIntent(event.payload_text)
      : [{
          type,
          text: finalResponse ? `Agent final response: ${event.payload_text}` : event.payload_text,
        }];
    await client.query(`
      DELETE FROM context_items
      WHERE workspace_id = $2 AND id IN (
        SELECT context_item_id FROM context_item_sources
        WHERE source_event_id = $1 AND relationship LIKE 'derived%'
      )
    `, [sourceEventId, event.workspace_id]);
    for (const [index, projection] of projections.entries()) {
      const contextItemId = randomUUID();
      await client.query(`
        INSERT INTO context_items (
          id, workspace_id, work_thread_id, type, text, authority,
          confidence, state, created_by_agent_identity_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
      `, [
        contextItemId,
        event.workspace_id,
        event.work_thread_id,
        projection.type,
        projection.text,
        finalResponse ? 2 : 3,
        finalResponse ? 0.8 : 1,
        event.agent_identity_id,
      ]);
      await client.query(`
        INSERT INTO context_item_sources (context_item_id, source_event_id, relationship)
        VALUES ($1, $2, $3)
      `, [contextItemId, sourceEventId, `derived:${index}`]);
    }
    await client.query(`
      UPDATE work_threads SET version = version + 1, updated_at = now()
      WHERE id = $1 AND workspace_id = $2
    `, [event.work_thread_id, event.workspace_id]);
    if (finalResponse && event.agent_session_id) {
      await client.query(`
        UPDATE handoffs
        SET status = 'completed', completed_at = COALESCE(completed_at, now())
        WHERE workspace_id = $1 AND work_thread_id = $2
          AND claimed_by_session_id = $3 AND status = 'claimed'
      `, [event.workspace_id, event.work_thread_id, event.agent_session_id]);
    }
  });
}

async function enforceRetention(db: Database, job: Job): Promise<void> {
  if (!job.workspace_id) throw new Error("enforce_retention requires workspace_id");
  await db.query(`
    UPDATE source_events se
    SET payload_json = jsonb_build_object(
          'schema_version', se.schema_version,
          'event_id', se.external_id,
          'event_type', se.event_type,
          'retained_projection_only', true
        ),
        payload_text = NULL
    FROM workspaces w
    WHERE se.workspace_id = $1 AND w.id = se.workspace_id
      AND se.occurred_at < now() - (w.retention_days * interval '1 day')
      AND se.payload_text IS NOT NULL
  `, [job.workspace_id]);
}

async function deleteWorkspace(db: Database, job: Job): Promise<void> {
  if (!job.workspace_id) throw new Error("delete_workspace requires workspace_id");
  await db.query(`
    DELETE FROM workspaces
    WHERE id = $1 AND deletion_requested_at IS NOT NULL
  `, [job.workspace_id]);
}

export async function enqueueRetentionJobs(db: Database, now = new Date()): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  const result = await db.query(`
    INSERT INTO jobs (id, workspace_id, kind, dedupe_key, payload_json, state)
    SELECT gen_random_uuid(), id, 'enforce_retention', id::text || ':' || $1,
      jsonb_build_object('workspace_id', id), 'pending'
    FROM workspaces
    WHERE deletion_requested_at IS NULL
    ON CONFLICT (kind, dedupe_key) DO NOTHING
  `, [day]);
  return result.rowCount ?? 0;
}

const PROJECTED_TYPES: Record<string, string | undefined> = {
  action: "observation",
  observation: "observation",
  decision: "decision",
  constraint: "constraint",
  attempt: "attempt",
  failure: "failure",
  evidence: "evidence",
  outcome: "outcome",
  session_ended: "outcome",
  status_changed: "current_state",
};

export function projectSlackIntent(text: string): Array<{ type: string; text: string }> {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const result = [{ type: "objective", text: lines[0]! }];
  for (const line of lines.slice(1)) {
    if (/\b(did not|didn't|failed|does not work|doesn't work)\b/i.test(line)) {
      result.push({ type: "failure", text: line });
      continue;
    }
    if (/^(return|should|must|need to|expected)\b/i.test(line)) {
      result.push({ type: "expected_result", text: line });
    } else {
      result.push({ type: "observation", text: line });
    }
    if (/\b(without|must not|do not|don't|cannot|can't)\b/i.test(line)) {
      result.push({ type: "constraint", text: line });
    }
  }
  return result;
}

export async function runOneJob(db: Database, workerId: string): Promise<boolean> {
  const job = await claimJob(db, workerId);
  if (!job) return false;
  try {
    if (job.kind === "project_event") await projectEvent(db, job);
    else if (job.kind === "enforce_retention") await enforceRetention(db, job);
    else if (job.kind === "delete_workspace") await deleteWorkspace(db, job);
    else if (job.kind === "stripe_event") {
      await processStripeEvent(db, job.payload_json as unknown as Stripe.Event);
    }
    else throw new Error(`Unsupported job kind: ${job.kind}`);
    await transaction(db, (client) => complete(client, job));
  } catch (error) {
    await transaction(db, (client) => fail(client, job, error));
  }
  return true;
}

export async function runWorker(signal?: AbortSignal): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const workerId = randomUUID();
  let nextRetentionSweep = 0;
  try {
    while (!signal?.aborted) {
      if (Date.now() >= nextRetentionSweep) {
        await enqueueRetentionJobs(db);
        nextRetentionSweep = Date.now() + 60 * 60_000;
      }
      if (!await runOneJob(db, workerId)) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", finish);
            resolve();
          };
          const timeout = setTimeout(finish, 1_000);
          signal?.addEventListener("abort", finish, { once: true });
        });
      }
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shutdown = new AbortController();
  process.once("SIGTERM", () => shutdown.abort());
  process.once("SIGINT", () => shutdown.abort());
  void runWorker(shutdown.signal).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      level: "error",
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
