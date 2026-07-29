import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueAgentCredential } from "../src/agent-auth.js";
import { createDatabase, type Database } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createApp } from "../src/server.js";
import { ingestConnectorWebhook } from "../src/connectors.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const pepper = "integration-test-pepper-value-32-bytes";
const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`./fixtures/cloud-contract/v3/${name}`, import.meta.url), "utf8"));

suite("alpha PostgreSQL runtime", () => {
  let db: Database;
  let workspaceId: string;
  let token: string;
  let ownerId: string;

  const post = (path: string, body: unknown, bearer = token) => createApp(db, pepper).request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
    ownerId = randomUUID(); workspaceId = randomUUID();
    const agentId = randomUUID();
    const credential = issueAgentCredential(pepper); token = credential.token;
    await db.query(`INSERT INTO workspaces (id,name,slug,owner_user_id) VALUES ($1,'Test',$2,$3)`, [workspaceId, `test-${workspaceId}`, ownerId]);
    await db.query(`INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId, ownerId]);
    await db.query(`INSERT INTO agent_identities (id,workspace_id,name,kind,created_by_user_id) VALUES ($1,$2,'Allowed','codex',$3)`, [agentId, workspaceId, ownerId]);
    await db.query(`INSERT INTO agent_credentials (id,workspace_id,agent_identity_id,token_prefix,secret_hash,scopes,created_by_user_id) VALUES ($1,$2,$3,$4,$5,ARRAY['events:write','context:read','outcomes:write'],$6)`, [randomUUID(), workspaceId, agentId, credential.prefix, credential.secretHash, ownerId]);
  });
  afterAll(async () => { await db.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]); await db.end(); });

  it("stores agent events idempotently", async () => {
    const body = fixture("event-batch-request.json");
    expect((await post("/v1/events/batch", body)).status).toBe(200);
    expect(await (await post("/v1/events/batch", body)).json()).toMatchObject({ accepted_event_ids: [], existing_event_ids: ["event-1"] });
    expect((await db.query(`SELECT count(*)::int AS count FROM source_records WHERE workspace_id=$1`, [workspaceId])).rows[0].count).toBe(1);
  });

  it("keeps the final schema stable across migration reruns", async () => {
    expect(await migrate(db)).toEqual([]);
    const tables = (await db.query<{ source_records: string; agent_sessions: string }>(`
      SELECT to_regclass('source_records')::text AS source_records,
             to_regclass('agent_sessions')::text AS agent_sessions
    `)).rows[0];
    expect(tables).toEqual({ source_records: "source_records", agent_sessions: "agent_sessions" });
    await db.query(`
      INSERT INTO source_records
        (id, workspace_id, source_type, external_id, record_type, repository_id, content, event_at)
      VALUES ($1, $2, 'linear', 'LIN-1', 'issue', 'github.com/example/alpha', 'Test issue', now())
    `, [randomUUID(), workspaceId]);
  });

  it("returns bounded context or explicit abstention", async () => {
    const body = { ...fixture("resolve-request.json"), repository_key: "github.com/none/repo", agent_session_id: "none", idempotency_key: "none" };
    expect((await (await post("/v1/context/resolve", body)).json()).state).toBe("abstained");
    await db.query(`INSERT INTO source_records (id,workspace_id,source_type,external_id,record_type,repository_id,content,event_at) VALUES ($1,$2,'github','issue-1','decision','github.com/none/repo','use the alpha path',now())`, [randomUUID(), workspaceId]);
    expect((await (await post("/v1/context/resolve", body)).json()).state).toBe("context");
  });

  it("stores outcomes without Work Thread tables", async () => {
    const body = { ...fixture("outcome-request.json"), agent_session_id: "event-session-1", idempotency_key: "outcome-1" };
    expect((await post("/v1/outcomes", body)).status).toBe(201);
    expect((await db.query(`SELECT count(*)::int AS count FROM source_records WHERE workspace_id=$1 AND record_type='outcome'`, [workspaceId])).rows[0].count).toBe(1);
  });

  it("accepts Codex and Claude Code only", async () => {
    const rows = (await db.query(`SELECT kind FROM agent_identities WHERE workspace_id=$1`, [workspaceId])).rows;
    expect(rows.every((row) => ["codex", "claude-code"].includes(row.kind))).toBe(true);
  });

  it("correlates Slack and GitHub context into the next agent briefing", async () => {
    const connectionId = randomUUID();
    await db.query(`INSERT INTO connector_connections (id,workspace_id,provider,name,external_account_id,created_by_user_id) VALUES ($1,$2,'slack','Slack test','team-1',$3)`, [connectionId, workspaceId, ownerId]);
    await db.query(`INSERT INTO connector_scope_mappings (id,workspace_id,connector_connection_id,external_scope_id,external_scope_name,repository_key,created_by_user_id) VALUES ($1,$2,$3,'channel-1','bugs','github.com/example/alpha',$4)`, [randomUUID(), workspaceId, connectionId, ownerId]);
    await ingestConnectorWebhook(db, { provider: "slack", externalAccountId: "team-1", externalId: "slack:bug-1", entityKey: "slack:bug-1", providerEventId: "slack-delivery-1", eventType: "observation", title: "Bug discussion", text: "GitHub issue https://github.com/example/alpha/issues/7 is blocked", externalScopeId: "channel-1", repositoryKey: "github.com/example/alpha", occurredAt: new Date(), raw: {} });
    await db.query(`INSERT INTO source_records (id,workspace_id,source_type,external_id,record_type,repository_id,issue_or_pr_reference,content,source_url,event_at) VALUES ($1,$2,'github','issue-7','issue','github.com/example/alpha','7','Fix the blocked auth flow','https://github.com/example/alpha/issues/7',now())`, [randomUUID(), workspaceId]);
    const body = { ...fixture("resolve-request.json"), repository_key: "github.com/example/alpha", explicit_references: ["https://github.com/example/alpha/issues/7"], agent_session_id: "claude-session", idempotency_key: "briefing-1" };
    const response = await post("/v1/context/resolve", body);
    expect((await response.json()).state).toBe("context");
  });

  it("creates one Linear-keyed Work Thread from explicit cross-source references", async () => {
    const linearConnection = randomUUID();
    const slackConnection = randomUUID();
    const githubConnection = randomUUID();
    await db.query(`INSERT INTO connector_connections (id,workspace_id,provider,name,external_account_id,created_by_user_id) VALUES ($1,$2,'linear','Linear test','linear-org-1',$3),($4,$2,'slack','Slack test 2','slack-team-2',$3),($5,$2,'github','GitHub test 2','github-install-2',$3)`, [linearConnection, workspaceId, ownerId, slackConnection, githubConnection]);
    await db.query(`INSERT INTO connector_scope_mappings (id,workspace_id,connector_connection_id,external_scope_id,external_scope_name,repository_key,created_by_user_id) VALUES ($1,$2,$3,'linear-team-1','Engineering','github.com/example/alpha',$4),($5,$2,$6,'slack-channel-2','auth','github.com/example/alpha',$4)`, [randomUUID(), workspaceId, linearConnection, ownerId, randomUUID(), slackConnection]);
    await ingestConnectorWebhook(db, { provider: "slack", externalAccountId: "slack-team-2", externalId: "slack:LIN-42", entityKey: "slack:LIN-42", providerEventId: "slack-LIN-42-v1", eventType: "constraint", title: "SSO constraint", text: "LIN-42 enterprise SSO sessions must not be extended automatically", externalScopeId: "slack-channel-2", repositoryKey: "github.com/example/alpha", occurredAt: new Date(), raw: {} });
    await ingestConnectorWebhook(db, { provider: "github", externalAccountId: "github-install-2", externalId: "github:LIN-42", entityKey: "github:LIN-42", providerEventId: "github-LIN-42-v1", eventType: "failure", title: "Reverted refresh retry", text: "LIN-42 retrying refresh requests created duplicate sessions", canonicalUrl: "https://github.com/example/alpha/pull/42", externalScopeId: "repo-1", repositoryKey: "github.com/example/alpha", occurredAt: new Date(), raw: {} });
    const linear = await ingestConnectorWebhook(db, { provider: "linear", externalAccountId: "linear-org-1", externalId: "Issue:LIN-42", entityKey: "Issue:LIN-42", providerEventId: "linear-LIN-42-v1", eventType: "decision", title: "Fix token refresh logout", text: "LIN-42 Fix users being logged out during token refresh", canonicalUrl: "https://linear.app/acme/issue/LIN-42/fix-refresh", externalScopeId: "linear-team-1", repositoryKey: "github.com/example/alpha", occurredAt: new Date(), raw: { identifier: "LIN-42" } });
    expect(linear.work_thread_id).toBeTruthy();
    const thread = (await db.query<{ source_count: number; claim_types: string[] }>(`
      SELECT count(DISTINCT evidence.source_record_id)::int AS source_count,
             array_agg(DISTINCT claims.claim_type ORDER BY claims.claim_type) AS claim_types
      FROM work_threads thread
      JOIN work_thread_evidence evidence ON evidence.work_thread_id=thread.id
      JOIN claims ON claims.work_thread_id=thread.id
      WHERE thread.workspace_id=$1 AND thread.linear_issue_key='LIN-42'
    `, [workspaceId])).rows[0];
    expect(thread.source_count).toBe(3);
    expect(thread.claim_types).toEqual(["attempt", "constraint", "requirement"]);

    const request = { ...fixture("resolve-request.json"), request_text: "Implement LIN-42", repository_key: "github.com/example/alpha", explicit_references: ["LIN-42"], agent_session_id: "golden-session", idempotency_key: "LIN-42-context-1" };
    const first = await (await post("/v1/context/resolve", request)).json() as { state: string; receipt_id: string; items: Array<{ source: { provider: string } }> };
    expect(first.state).toBe("context");
    expect(first.items.map((item) => item.source.provider).sort()).toEqual(["github", "linear", "slack"]);

    const outcome = { ...fixture("outcome-request.json"), agent_session_id: "golden-session", receipt_id: first.receipt_id, summary: "Preserved enterprise SSO expiry and avoided refresh retries.", idempotency_key: "LIN-42-outcome-1" };
    expect((await post("/v1/outcomes", outcome)).status).toBe(201);
    const second = await (await post("/v1/context/resolve", { ...request, agent_session_id: "golden-session-2", idempotency_key: "LIN-42-context-2" })).json() as { state: string; items: Array<{ type: string; text: string }> };
    expect(second.state).toBe("context");
    expect(second.items).toContainEqual(expect.objectContaining({ type: "outcome", text: "Preserved enterprise SSO expiry and avoided refresh retries." }));

    const dashboard = createApp(db, pepper, { authenticateHuman: async (token) => token === "human" ? { userId: ownerId } : null });
    const headers = { authorization: "Bearer human" };
    const listed = await (await dashboard.request(`/v1/admin/work-threads?workspace_id=${workspaceId}`, { headers })).json() as Array<{ id: string; linear_issue_key: string; claim_count: number }>;
    expect(listed).toContainEqual(expect.objectContaining({ linear_issue_key: "LIN-42", claim_count: 4 }));
    const detail = await (await dashboard.request(`/v1/admin/work-threads/${linear.work_thread_id}?workspace_id=${workspaceId}`, { headers })).json() as { claims: unknown[]; receipts: unknown[] };
    expect(detail.claims).toHaveLength(4);
    expect(detail.receipts).toHaveLength(2);
  });

  it("starts device authentication for the two supported agents", async () => {
    const response = await createApp(db, pepper, { authenticateHuman: async (value) => value === "human" ? { userId: ownerId } : null }).request("/v1/device/start", {
      method: "POST",
      headers: { authorization: "Bearer human", "content-type": "application/json" },
      body: JSON.stringify({ schema_version: 3, device_name: "test", platform: "claude-code", requested_scopes: ["events:write", "context:read"] }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).schema_version).toBe(3);
  });

  it("accepts signed Slack and GitHub webhook deliveries", async () => {
    const githubConnection = randomUUID();
    await db.query(`INSERT INTO connector_connections (id,workspace_id,provider,name,external_account_id,created_by_user_id) VALUES ($1,$2,'github','GitHub test','installation-1',$3)`, [githubConnection, workspaceId, ownerId]);
    const app = createApp(db, pepper, { connectorRuntime: { encryptionKey: Buffer.alloc(32), webhookSecrets: { slack: "slack-secret", github: "github-secret" } } });
    const slackBody = JSON.stringify({ type: "event_callback", team_id: "team-1", event_id: "slack-http-1", event: { type: "message", channel: "channel-1", ts: "1710000000.000001", text: "The auth issue is blocked" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const slackSignature = `v0=${createHmac("sha256", "slack-secret").update(`v0:${timestamp}:${slackBody}`).digest("hex")}`;
    expect((await app.request("/webhooks/connectors/slack", { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": slackSignature }, body: slackBody })).status).toBe(200);
    const githubBody = JSON.stringify({ action: "opened", installation: { id: "installation-1" }, repository: { id: 7, full_name: "example/alpha" }, issue: { id: 8, title: "Auth issue", body: "Fix this", html_url: "https://github.com/example/alpha/issues/8", created_at: new Date().toISOString() } });
    const githubSignature = `sha256=${createHmac("sha256", "github-secret").update(githubBody).digest("hex")}`;
    expect((await app.request("/webhooks/connectors/github", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": githubSignature, "x-github-event": "issues", "x-github-delivery": "github-http-1" }, body: githubBody })).status).toBe(200);
    expect((await db.query(`SELECT count(*)::int AS count FROM source_records WHERE workspace_id=$1 AND source_type IN ('slack','github')`, [workspaceId])).rows[0].count).toBeGreaterThanOrEqual(2);
  });
});
