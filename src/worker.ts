import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { loadConfig } from "./config.js";
import { createDatabase, transaction, type Database } from "./db.js";
import { processStripeEvent } from "./billing.js";
import type Stripe from "stripe";
import { connectorKey, syncSlackThread, type ConnectorRuntime } from "./connectors.js";
import { synthesizeSlackThread } from "./synthesis.js";

export interface Job {
  id: string;
  kind: string;
  workspace_id: string | null;
  payload_json: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

interface ProjectedContextItem {
  type: string;
  text: string;
  authority: number;
  confidence: number;
}

interface ProjectedItemBatch {
  items: ProjectedContextItem[];
  fallbackReason?: string;
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
    WHERE id = $1 AND state = 'leased'
  `, [job.id]);
}

async function fail(client: pg.PoolClient, job: Job, error: unknown): Promise<void> {
  const dead = job.attempts >= job.max_attempts;
  const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
  await client.query(`
    UPDATE jobs
    SET state = $2, leased_by = NULL, lease_until = NULL, last_error = $3,
        next_run_at = now() + ($4 * interval '1 second'), updated_at = now()
    WHERE id = $1 AND state = 'leased'
  `, [
    job.id,
    dead ? "dead" : "failed",
    error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
    delaySeconds,
  ]);
}

async function projectEvent(
  db: Database,
  job: Job,
  connectorRuntime?: ConnectorRuntime,
): Promise<void> {
  const sourceEventId = job.payload_json["source_event_id"];
  if (typeof sourceEventId !== "string") throw new Error("project_event requires source_event_id");
  await transaction(db, async (client) => {
    const result = await client.query<{
      id: string;
      workspace_id: string;
      work_thread_id: string | null;
      link_work_thread_id: string | null;
      agent_identity_id: string | null;
      agent_session_id: string | null;
      source: string;
      event_type: string;
      payload_json: Record<string, unknown>;
      payload_text: string | null;
      source_entity_id: string | null;
      current_source_event_id: string | null;
    }>(`
      SELECT event.id, event.workspace_id,
        coalesce(entity.work_thread_id, event.work_thread_id, link.work_thread_id) AS work_thread_id,
        link.work_thread_id AS link_work_thread_id,
        event.agent_identity_id, event.agent_session_id, event.source,
        event.event_type, event.payload_json, event.payload_text,
        event.source_entity_id, entity.current_source_event_id
      FROM source_events event
      LEFT JOIN source_entities entity ON entity.id = event.source_entity_id
      LEFT JOIN LATERAL (
        SELECT source_event_links.work_thread_id
        FROM source_event_links
        WHERE source_event_links.source_event_id = event.id
        ORDER BY source_event_links.created_at DESC
        LIMIT 1
      ) link ON true
      WHERE event.id = $1
      FOR UPDATE OF event
    `, [sourceEventId]);
    const event = result.rows[0];
    if (!event?.work_thread_id) return;
    const workThreadId = event.work_thread_id;
    const payloadText = projectedText(event.payload_text, event.payload_json);
    if (!payloadText) return;
    if (event.source_entity_id && event.current_source_event_id && event.current_source_event_id !== event.id) return;
    const workThread = (await client.query<{
      id: string;
      title: string;
      objective: string;
      status: string;
    }>(`
      SELECT id, title, objective, status
      FROM work_threads
      WHERE id = $1 AND workspace_id = $2
    `, [event.work_thread_id, event.workspace_id])).rows[0];
    if (!workThread) return;
    const finalResponse = event.event_type === "session_ended";
    const activeItems = (await client.query<{
      id: string;
      type: string;
      text: string;
      authority: number;
    }>(`
      SELECT id, type, text, authority
      FROM context_items
      WHERE workspace_id = $1 AND work_thread_id = $2
        AND state = 'active'
        AND (valid_until IS NULL OR valid_until > now())
      ORDER BY authority DESC, updated_at DESC
      LIMIT 100
    `, [event.workspace_id, workThread.id])).rows;
    const projectionResult = event.source === "slack"
      ? await projectSlackSnapshot({
        id: event.id,
        workspace_id: event.workspace_id,
        work_thread_id: workThreadId,
        source_entity_id: event.source_entity_id,
        payload_json: event.payload_json,
        payload_text: payloadText,
      }, workThread, activeItems, connectorRuntime)
      : { items: projectAgentEvent({
        event_type: event.event_type,
        payload_text: payloadText,
        payload_json: event.payload_json,
      }) };
    if (projectionResult.items.length === 0) return;
    if (event.source_entity_id) {
      await client.query(`
        UPDATE context_items item SET state = 'superseded', updated_at = now()
        WHERE item.workspace_id = $2 AND item.state = 'active' AND item.id IN (
          SELECT source.context_item_id
          FROM context_item_sources source
          JOIN source_events prior ON prior.id = source.source_event_id
          WHERE prior.source_entity_id = $1 AND prior.id <> $3
            AND source.relationship LIKE 'derived%'
        )
      `, [event.source_entity_id, event.workspace_id, event.id]);
    }
    let materialChange = false;
    for (const [index, projection] of projectionResult.items.entries()) {
      const normalizedHash = hashProjection(projection.type, projection.text);
      const existing = (await client.query<{
        id: string;
        type: string;
        text: string;
      }>(`
        SELECT id, type, text
        FROM context_items
        WHERE workspace_id = $1 AND work_thread_id = $2
          AND normalized_hash = $3 AND state = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
        FOR UPDATE
      `, [event.workspace_id, workThread.id, normalizedHash])).rows[0];
      if (existing && existing.type === projection.type && existing.text === projection.text) {
        await client.query(`
          INSERT INTO context_item_sources (
            context_item_id, source_event_id, relationship
          ) VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
        `, [existing.id, sourceEventId, `derived:${index}`]);
        materialChange = true;
        continue;
      }
      if (existing) {
        await client.query(`
          UPDATE context_items
          SET state = 'superseded', updated_at = now()
          WHERE id = $1
        `, [existing.id]);
      }
      const contextItemId = randomUUID();
      await client.query(`
        INSERT INTO context_items (
          id, workspace_id, work_thread_id, type, text, authority,
          confidence, state, created_by_agent_identity_id,
          supersedes_context_item_id, normalized_hash, projector_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, 2)
      `, [
        contextItemId,
        event.workspace_id,
        event.work_thread_id,
        projection.type,
        projection.text,
        projection.authority,
        projection.confidence,
        event.agent_identity_id,
        existing?.id ?? null,
        normalizedHash,
      ]);
      await client.query(`
        INSERT INTO context_item_sources (
          context_item_id, source_event_id, relationship
        ) VALUES ($1, $2, $3)
      `, [contextItemId, sourceEventId, `derived:${index}`]);
      materialChange = true;
    }
    if (materialChange) {
      await client.query(`
        UPDATE work_threads SET version = version + 1, updated_at = now()
        WHERE id = $1 AND workspace_id = $2
      `, [event.work_thread_id, event.workspace_id]);
    }
    if (finalResponse && event.agent_session_id) {
      await client.query(`
        UPDATE handoffs
        SET status = 'completed', completed_at = COALESCE(completed_at, now())
        WHERE workspace_id = $1 AND work_thread_id = $2
          AND claimed_by_session_id = $3 AND status = 'claimed'
      `, [event.workspace_id, event.work_thread_id, event.agent_session_id]);
    }
    if (projectionResult.fallbackReason) {
      await client.query(`
        INSERT INTO audit_events (
          id, workspace_id, actor_type, actor_id, action,
          target_type, target_id, metadata_json
        ) VALUES ($1, $2, 'system', 'worker', 'projection.fallback', 'source_event', $3, $4)
      `, [
        randomUUID(),
        event.workspace_id,
        event.id,
        {
          source_event_id: event.id,
          fallback_reason: projectionResult.fallbackReason,
        },
      ]);
    }
  });
}

async function enforceRetention(db: Database, job: Job): Promise<void> {
  if (!job.workspace_id) throw new Error("enforce_retention requires workspace_id");
  await transaction(db, async (client) => {
    await client.query(`
      UPDATE context_items item SET state = 'deleted', updated_at = now()
      WHERE item.workspace_id = $1 AND item.id IN (
        SELECT source.context_item_id
        FROM context_item_sources source
        JOIN source_events event ON event.id = source.source_event_id
        JOIN workspaces workspace ON workspace.id = event.workspace_id
        WHERE event.workspace_id = $1
          AND event.occurred_at < now() - (workspace.retention_days * interval '1 day')
      )
    `, [job.workspace_id]);
    await client.query(`
      DELETE FROM source_events event
      USING workspaces workspace
      WHERE event.workspace_id = $1 AND workspace.id = event.workspace_id
        AND event.occurred_at < now() - (workspace.retention_days * interval '1 day')
    `, [job.workspace_id]);
  });
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

function projectAgentEvent(event: {
  event_type: string;
  payload_text: string;
  payload_json: Record<string, unknown>;
}): ProjectedContextItem[] {
  const text = event.payload_text.trim();
  switch (event.event_type) {
    case "user_prompt":
      return [{
        type: /^(continue|next|please|do|run|check|review)\b/i.test(text) ? "next_action" : "objective",
        text,
        authority: 2,
        confidence: 1,
      }];
    case "action":
      return [{ type: "observation", text, authority: 2, confidence: 1 }];
    case "attempt":
      return [{ type: "attempt", text, authority: 2, confidence: 1 }];
    case "failure":
      return [{ type: "failure", text, authority: 3, confidence: 1 }];
    case "evidence":
      return [{
        type: /\b(pass(?:ed)?|succeeded|verified|green)\b/i.test(text) ? "evidence" : "observation",
        text,
        authority: /\b(pass(?:ed)?|succeeded|verified|green)\b/i.test(text) ? 4 : 2,
        confidence: 1,
      }];
    case "decision":
      return [{ type: "decision", text, authority: 4, confidence: 1 }];
    case "constraint":
      return [{ type: "constraint", text, authority: 4, confidence: 1 }];
    case "status_changed":
      return [{ type: "current_state", text, authority: 3, confidence: 1 }];
    case "session_ended":
      return [{ type: "outcome", text: `Agent final response: ${text}`, authority: 2, confidence: 0.8 }];
    case "outcome":
      return [{ type: "outcome", text, authority: 4, confidence: 1 }];
    default:
      return [{ type: "observation", text, authority: 2, confidence: 1 }];
  }
}

function projectedText(
  payloadText: string | null,
  payloadJson: Record<string, unknown>,
): string {
  const value = payloadText
    ?? payloadJson["text"]
    ?? payloadJson["title"]
    ?? payloadJson["body"]
    ?? payloadJson["content"]
    ?? payloadJson["message"]
    ?? payloadJson["summary"]
    ?? "";
  return String(value).trim();
}

async function projectSlackSnapshot(
  event: {
    id: string;
    workspace_id: string;
    work_thread_id: string;
    source_entity_id: string | null;
    payload_json: Record<string, unknown>;
    payload_text: string;
  },
  workThread: {
    id: string;
    title: string;
    objective: string;
    status: string;
  },
  activeItems: Array<{
    id: string;
    type: string;
    text: string;
    authority: number;
  }>,
  connectorRuntime?: ConnectorRuntime,
): Promise<ProjectedItemBatch> {
  const raw = event.payload_json["raw"] as { messages?: Array<Record<string, unknown>>; thread_ts?: string } | undefined;
  const messages = (raw?.messages ?? []).map((message, index) => ({
    ts: String(message.ts ?? index),
    thread_ts: String(message.thread_ts ?? raw?.thread_ts ?? message.ts ?? index),
    user: message.user ? String(message.user) : null,
    text: String(message.text ?? ""),
    occurred_at: String(message.occurred_at ?? ""),
    edited_at: message.edited_at ? String(message.edited_at) : null,
  })).filter((message) => message.text.length > 0);
  const sourceRefs = messages.map((message, index) =>
    `${event.source_entity_id ?? event.id}:${message.ts}:${index}`);
  const synthesis = await synthesizeSlackThread({
    workThread,
    activeContextItems: activeItems,
    snapshot: {
      entityKey: String(event.payload_json["entityKey"] ?? event.id),
      threadTs: String(raw?.thread_ts ?? messages[0]?.thread_ts ?? ""),
      messages,
    },
    allowedTypes: [
      "objective",
      "current_state",
      "decision",
      "constraint",
      "observation",
      "attempt",
      "failure",
      "blocker",
      "evidence",
      "expected_result",
      "next_action",
      "outcome",
    ],
    sourceRefs,
  }, connectorRuntime?.synthesis ?? {});
  return {
    items: synthesis.candidates.map((candidate) => ({
      type: candidate.type,
      text: candidate.text,
      authority: candidate.confidence >= 0.9 ? 4 : candidate.confidence >= 0.7 ? 3 : 2,
      confidence: candidate.confidence,
    })),
    fallbackReason: synthesis.fallback_reason,
  };
}

function hashProjection(type: string, text: string): string {
  return createHash("sha256")
    .update(type.trim().toLowerCase())
    .update("\0")
    .update(text.trim().replace(/\s+/g, " "))
    .digest("hex");
}

export async function runOneJob(
  db: Database,
  workerId: string,
  connectorRuntime?: ConnectorRuntime,
): Promise<boolean> {
  const job = await claimJob(db, workerId);
  if (!job) return false;
  try {
    if (job.kind === "project_event") await projectEvent(db, job, connectorRuntime);
    else if (job.kind === "sync_slack_thread") {
      if (!connectorRuntime) throw new Error("Slack connector runtime is not configured");
      await syncSlackThread(
        db,
        job.payload_json,
        connectorRuntime as Pick<ConnectorRuntime, "encryptionKey" | "fetch">,
      );
    }
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
  const connectorRuntime = config.CONNECTOR_ENCRYPTION_KEY
    ? {
        encryptionKey: connectorKey(config.CONNECTOR_ENCRYPTION_KEY),
        webhookSecrets: {},
        synthesis: config.CONTEXT_SYNTHESIS_BASE_URL && config.CONTEXT_SYNTHESIS_API_KEY && config.CONTEXT_SYNTHESIS_MODEL
          ? {
              baseUrl: config.CONTEXT_SYNTHESIS_BASE_URL,
              apiKey: config.CONTEXT_SYNTHESIS_API_KEY,
              model: config.CONTEXT_SYNTHESIS_MODEL,
              timeoutMs: config.CONTEXT_SYNTHESIS_TIMEOUT_MS,
            }
          : undefined,
      }
    : undefined;
  let nextRetentionSweep = 0;
  try {
    while (!signal?.aborted) {
      if (Date.now() >= nextRetentionSweep) {
        await enqueueRetentionJobs(db);
        nextRetentionSweep = Date.now() + 60 * 60_000;
      }
      if (!await runOneJob(db, workerId, connectorRuntime)) {
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
