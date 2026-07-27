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
    expect((await db.query(`SELECT count(*)::int AS count FROM alpha_source_records WHERE workspace_id=$1`, [workspaceId])).rows[0].count).toBe(1);
  });

  it("returns bounded context or explicit abstention", async () => {
    const body = { ...fixture("resolve-request.json"), repository_key: "github.com/none/repo", agent_session_id: "none", idempotency_key: "none" };
    expect((await (await post("/v1/context/resolve", body)).json()).state).toBe("abstained");
    await db.query(`INSERT INTO alpha_source_records (id,workspace_id,provider,external_id,record_type,repository,content,event_at) VALUES ($1,$2,'github','issue-1','decision','github.com/none/repo','use the alpha path',now())`, [randomUUID(), workspaceId]);
    expect((await (await post("/v1/context/resolve", body)).json()).state).toBe("context");
  });

  it("stores outcomes without Work Thread tables", async () => {
    const body = { ...fixture("outcome-request.json"), agent_session_id: "event-session-1", idempotency_key: "outcome-1" };
    expect((await post("/v1/outcomes", body)).status).toBe(201);
    expect((await db.query(`SELECT count(*)::int AS count FROM alpha_source_records WHERE workspace_id=$1 AND record_type='outcome'`, [workspaceId])).rows[0].count).toBe(1);
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
    await db.query(`INSERT INTO alpha_source_records (id,workspace_id,provider,external_id,record_type,repository,issue_or_pr_reference,content,source_url,event_at) VALUES ($1,$2,'github','issue-7','issue','github.com/example/alpha','7','Fix the blocked auth flow','https://github.com/example/alpha/issues/7',now())`, [randomUUID(), workspaceId]);
    const body = { ...fixture("resolve-request.json"), repository_key: "github.com/example/alpha", explicit_references: ["https://github.com/example/alpha/issues/7"], agent_session_id: "claude-session", idempotency_key: "briefing-1" };
    const response = await post("/v1/context/resolve", body);
    expect((await response.json()).state).toBe("context");
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
    expect((await db.query(`SELECT count(*)::int AS count FROM alpha_source_records WHERE workspace_id=$1 AND provider IN ('slack','github')`, [workspaceId])).rows[0].count).toBeGreaterThanOrEqual(2);
  });
});
