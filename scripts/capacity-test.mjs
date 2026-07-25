import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { issueAgentCredential } from "../dist/agent-auth.js";
import { createDatabase } from "../dist/db.js";
import { createApp } from "../dist/server.js";
import { runOneJob } from "../dist/worker.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");
const pepper = process.env.AGENT_TOKEN_PEPPER ?? "capacity-test-pepper-value-32-bytes";
const threadCount = Number(process.env.CAPACITY_THREADS ?? 10_000);
const eventsPerThread = Number(process.env.CAPACITY_EVENTS_PER_THREAD ?? 100);
const contextPerThread = Number(process.env.CAPACITY_CONTEXT_PER_THREAD ?? 10);
const concurrency = Number(process.env.CAPACITY_CONCURRENCY ?? 100);
const expectedEvents = threadCount * eventsPerThread;
const expectedItems = threadCount * contextPerThread;
const workspaceId = randomUUID();
const ownerId = randomUUID();
const agentId = randomUUID();
const deniedAgentId = randomUUID();
const sessionId = `capacity-session-${randomUUID()}`;
const primary = issueAgentCredential(pepper);
const denied = issueAgentCredential(pepper);
const db = createDatabase(databaseUrl);

try {
  await db.query("BEGIN");
  await db.query(`
    INSERT INTO workspaces (id, name, slug, owner_user_id)
    VALUES ($1, 'Capacity proof', $2, $3)
  `, [workspaceId, `capacity-${workspaceId}`, ownerId]);
  await db.query(`
    INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES ($1, $2, 'owner')
  `, [workspaceId, ownerId]);
  await db.query(`
    INSERT INTO agent_identities (id, workspace_id, name, kind, created_by_user_id)
    VALUES
      ($1, $3, 'Capacity Codex', 'codex', $4),
      ($2, $3, 'Ungrounded Codex', 'codex', $4)
  `, [agentId, deniedAgentId, workspaceId, ownerId]);
  await db.query(`
    INSERT INTO agent_credentials (
      id, workspace_id, agent_identity_id, token_prefix, secret_hash, scopes,
      created_by_user_id
    ) VALUES
      ($1, $2, $3, $4, $5, ARRAY['events:write','context:read'], $6),
      ($7, $2, $8, $9, $10, ARRAY['events:write','context:read'], $6)
  `, [
    randomUUID(), workspaceId, agentId, primary.prefix, primary.secretHash, ownerId,
    randomUUID(), deniedAgentId, denied.prefix, denied.secretHash,
  ]);
  await db.query(`
    INSERT INTO agent_sessions (
      id, workspace_id, agent_identity_id, credential_id, source_session_id,
      source_platform, started_at, last_event_at
    )
    SELECT $1, $2, $3, id, $1, 'codex', now(), now()
    FROM agent_credentials
    WHERE workspace_id = $2 AND agent_identity_id = $3
    LIMIT 1
  `, [sessionId, workspaceId, agentId]);
  await db.query(`
    CREATE TEMP TABLE capacity_threads (
      id uuid PRIMARY KEY,
      ordinal integer NOT NULL
    ) ON COMMIT DROP
  `);
  await db.query(`
    INSERT INTO capacity_threads
    SELECT gen_random_uuid(), ordinal
    FROM generate_series(1, $1::integer) ordinal
  `, [threadCount]);
  await db.query(`
    INSERT INTO work_threads (
      id, workspace_id, title, objective, status, repository_key,
      idempotency_key, created_by_agent_identity_id
    )
    SELECT id, $1, 'Capacity target ' || ordinal,
      'Continue synthetic work item ' || ordinal, 'active',
      'termyte/capacity', 'capacity:' || ordinal, $2
    FROM capacity_threads
  `, [workspaceId, agentId]);
  await db.query(`
    INSERT INTO work_thread_agent_grants (
      id, workspace_id, work_thread_id, agent_identity_id, source
    )
    SELECT gen_random_uuid(), $1, id, $2, 'creator'
    FROM capacity_threads
  `, [workspaceId, agentId]);
  await db.query(`
    CREATE TEMP TABLE capacity_pairs ON COMMIT DROP AS
    SELECT gen_random_uuid() AS item_id, gen_random_uuid() AS event_id,
      thread.id AS work_thread_id, event_number AS ordinal
    FROM capacity_threads thread
    CROSS JOIN generate_series(1, $1::integer) event_number
  `, [contextPerThread]);
  await db.query(`
    INSERT INTO source_events (
      id, workspace_id, work_thread_id, agent_identity_id, agent_session_id,
      source, external_id, event_type, occurred_at, schema_version,
      payload_json, payload_text
    )
    SELECT event_id, $1, work_thread_id, $2, $3, 'codex',
      work_thread_id::text || ':' || ordinal, 'observation',
      now() - (ordinal * interval '1 millisecond'), 1,
      jsonb_build_object(
        'event_id', work_thread_id::text || ':' || ordinal,
        'event_type', 'observation'
      ),
      'Synthetic observation ' || ordinal
    FROM capacity_pairs
  `, [workspaceId, agentId, sessionId]);
  await db.query(`
    INSERT INTO source_events (
      id, workspace_id, work_thread_id, agent_identity_id, agent_session_id,
      source, external_id, event_type, occurred_at, schema_version,
      payload_json, payload_text
    )
    SELECT gen_random_uuid(), $1, thread.id, $2, $3, 'codex',
      thread.id::text || ':' || event_number, 'observation',
      now() - (event_number * interval '1 millisecond'), 1,
      jsonb_build_object(
        'event_id', thread.id::text || ':' || event_number,
        'event_type', 'observation'
      ),
      'Synthetic observation ' || event_number
    FROM capacity_threads thread
    CROSS JOIN generate_series($4::integer + 1, $5::integer) event_number
  `, [workspaceId, agentId, sessionId, contextPerThread, eventsPerThread]);
  await db.query(`
    INSERT INTO context_items (
      id, workspace_id, work_thread_id, type, text, authority,
      confidence, state, created_by_agent_identity_id
    )
    SELECT item_id, $1, work_thread_id, 'observation',
      'Projected capacity context ' || ordinal, 3, 1, 'active', $2
    FROM capacity_pairs
  `, [workspaceId, agentId]);
  await db.query(`
    INSERT INTO context_item_sources (
      context_item_id, source_event_id, relationship
    )
    SELECT item_id, event_id, 'derived'
    FROM capacity_pairs
  `);
  await db.query("COMMIT");
  await db.query(`
    ANALYZE work_threads;
    ANALYZE work_thread_agent_grants;
    ANALYZE context_items;
    ANALYZE context_item_sources;
  `);

  const counts = (await db.query(`
    SELECT
      (SELECT count(*)::integer FROM work_threads WHERE workspace_id = $1) AS work_threads,
      (SELECT count(*)::integer FROM source_events WHERE workspace_id = $1) AS source_events,
      (SELECT count(*)::integer FROM context_items WHERE workspace_id = $1) AS context_items
  `, [workspaceId])).rows[0];
  if (counts.work_threads !== threadCount
    || counts.source_events !== expectedEvents
    || counts.context_items !== expectedItems) {
    throw new Error(`Capacity seed mismatch: ${JSON.stringify(counts)}`);
  }

  const target = (await db.query(`
    SELECT id FROM capacity_threads WHERE ordinal = $1
  `, [threadCount]).catch(() => ({ rows: [] }))).rows[0];
  const targetWorkThreadId = target?.id ?? (await db.query(`
    SELECT id FROM work_threads
    WHERE workspace_id = $1 AND title = $2
  `, [workspaceId, `Capacity target ${threadCount}`])).rows[0].id;
  const app = createApp(db, pepper);
  const resolve = async (index) => {
    const started = performance.now();
    const response = await app.request("/v1/context/resolve", {
      method: "POST",
      headers: {
        authorization: `Bearer ${primary.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: 1,
        request_text: `Continue capacity target ${threadCount}`,
        agent_session_id: `${sessionId}:resolve:${index}`,
        repository_key: "termyte/capacity",
        token_budget: 2_000,
        idempotency_key: `capacity-resolve:${index}`,
      }),
    });
    const body = await response.json();
    if (response.status !== 200 || body.state !== "resolved"
      || body.work_thread_id !== targetWorkThreadId) {
      throw new Error(`Incorrect capacity resolution: ${response.status} ${JSON.stringify(body)}`);
    }
    return performance.now() - started;
  };
  const resolutionResults = await Promise.allSettled(
    Array.from({ length: concurrency }, (_, index) => resolve(index)),
  );
  const failedResolution = resolutionResults.find((result) => result.status === "rejected");
  if (failedResolution?.status === "rejected") throw failedResolution.reason;
  const latencies = resolutionResults.map((result) => {
    if (result.status !== "fulfilled") throw new Error("Unreachable rejected resolution");
    return result.value;
  });
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
  if (p95 >= 2_000) throw new Error(`Resolve P95 ${p95.toFixed(1)}ms exceeded 2000ms`);

  const deniedResponse = await app.request("/v1/context/resolve", {
    method: "POST",
    headers: {
      authorization: `Bearer ${denied.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      schema_version: 1,
      request_text: `Continue capacity target ${threadCount}`,
      agent_session_id: `denied-${sessionId}`,
      work_thread_id: targetWorkThreadId,
      idempotency_key: "capacity-denied",
    }),
  });
  if (deniedResponse.status !== 404) {
    throw new Error(`Ungrant isolation failed with status ${deniedResponse.status}`);
  }

  await db.query(`
    INSERT INTO jobs (id, workspace_id, kind, dedupe_key, payload_json, state)
    SELECT gen_random_uuid(), $1, 'project_event',
      'capacity-job:' || $1::text || ':' || ordinal,
      jsonb_build_object('source_event_id', event.id), 'pending'
    FROM (
      SELECT id, row_number() OVER (ORDER BY id) AS ordinal
      FROM source_events WHERE workspace_id = $1 LIMIT 1_000
    ) event
  `, [workspaceId]);
  const workers = Array.from({ length: 4 }, (_, index) => (async () => {
    let processed = 0;
    while (await runOneJob(db, `capacity-worker-${index}`)) processed += 1;
    return processed;
  })());
  const processed = (await Promise.all(workers)).reduce((sum, value) => sum + value, 0);
  const jobs = (await db.query(`
    SELECT count(*) FILTER (WHERE state = 'succeeded')::integer AS succeeded,
      count(*) FILTER (WHERE attempts <> 1)::integer AS duplicate_claims
    FROM jobs WHERE workspace_id = $1 AND dedupe_key LIKE 'capacity-job:%'
  `, [workspaceId])).rows[0];
  if (processed !== 1_000 || jobs.succeeded !== 1_000 || jobs.duplicate_claims !== 0) {
    throw new Error(`Worker capacity proof failed: ${JSON.stringify({ processed, jobs })}`);
  }

  process.stdout.write(`${JSON.stringify({
    passed: true,
    seed: counts,
    concurrent_resolves: concurrency,
    resolve_p50_ms: Number(latencies[Math.floor(latencies.length * 0.5)].toFixed(1)),
    resolve_p95_ms: Number(p95.toFixed(1)),
    resolve_max_ms: Number(latencies.at(-1).toFixed(1)),
    workers: 4,
    jobs,
  }, null, 2)}\n`);
} finally {
  if (process.env.KEEP_CAPACITY_DATA !== "1") {
    await db.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]).catch(() => undefined);
  }
  await db.end();
}
