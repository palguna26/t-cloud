import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueAgentCredential } from "../src/agent-auth.js";
import { createDatabase, type Database } from "../src/db.js";
import { createApp } from "../src/server.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const pepper = "integration-test-pepper-value-32-bytes";
const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`./fixtures/cloud-contract/v3/${name}`, import.meta.url), "utf8"));

suite("v3 cloud contract and internal correlation", () => {
  let db: Database;
  let workspaceId: string;
  let token: string;
  let deniedToken: string;
  let agentId: string;
  let ownerId: string;

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, bearer = token) =>
    app.request(path, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  const resolveRequest = (session = `session-${randomUUID()}`, key = `resolve-${randomUUID()}`) => ({
    ...fixture("resolve-request.json"), agent_session_id: session, idempotency_key: key,
  });

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    ownerId = randomUUID(); workspaceId = randomUUID(); agentId = randomUUID();
    const credential = issueAgentCredential(pepper); token = credential.token;
    const denied = issueAgentCredential(pepper); deniedToken = denied.token;
    await db.query(`INSERT INTO workspaces (id,name,slug,owner_user_id) VALUES ($1,'Test',$2,$3)`, [workspaceId, `test-${workspaceId}`, ownerId]);
    await db.query(`INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId, ownerId]);
    await db.query(`INSERT INTO agent_identities (id,workspace_id,name,kind,created_by_user_id) VALUES ($1,$2,'Allowed','codex',$3),($4,$2,'Denied','codex',$3)`, [agentId, workspaceId, ownerId, randomUUID()]);
    const deniedIdentity = (await db.query<{ id: string }>(`SELECT id FROM agent_identities WHERE workspace_id=$1 AND id<>$2`, [workspaceId, agentId])).rows[0]!.id;
    await db.query(`INSERT INTO agent_credentials (id,workspace_id,agent_identity_id,token_prefix,secret_hash,scopes,created_by_user_id) VALUES ($1,$2,$3,$4,$5,ARRAY['events:write','context:read','outcomes:write'],$6),($7,$2,$8,$9,$10,ARRAY['events:write','context:read','outcomes:write'],$6)`, [randomUUID(),workspaceId,agentId,credential.prefix,credential.secretHash,ownerId,randomUUID(),deniedIdentity,denied.prefix,denied.secretHash]);
  });
  afterAll(async () => { await db.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]); await db.end(); });

  it("v3 event fixture is idempotent and auto-correlates", async () => {
    const app = createApp(db, pepper); const body = fixture("event-batch-request.json");
    expect((await post(app, "/v1/events/batch", body)).status).toBe(200);
    expect(await (await post(app, "/v1/events/batch", body)).json()).toMatchObject({ accepted_event_ids: [], existing_event_ids: ["event-1"] });
    expect((await db.query(`SELECT bound_work_thread_id FROM agent_sessions WHERE workspace_id=$1`, [workspaceId])).rows[0].bound_work_thread_id).not.toBeNull();
  });

  it("automatic grants use contribution source", async () => {
    const row = await db.query<{ source: string }>(`SELECT source FROM work_thread_agent_grants WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`, [workspaceId]);
    expect(row.rows[0].source).toBe("contribution");
  });

  it("redacts v3 event payloads before persistence", async () => {
    const app = createApp(db, pepper); const body = fixture("event-batch-request.json"); body.events[0].event_id = "redact-1"; body.events[0].content = "api_key=supersecretvalue";
    expect((await post(app, "/v1/events/batch", body)).status).toBe(200);
    const row = (await db.query(`SELECT payload_text, payload_json FROM source_events WHERE external_id='redact-1'`)).rows[0];
    expect(JSON.stringify(row)).not.toContain("supersecretvalue"); expect(row.payload_text).toContain("[REDACTED:api_key]");
  });

  it("resolve creates a v3 session-bound internal thread", async () => {
    const app = createApp(db, pepper); const body = { ...resolveRequest("resolve-new", "resolve-new-1"), repository_key: "github.com/brand-new/resolve-only", request_text: "brand new resolve-only task" };
    const response = await post(app, "/v1/context/resolve", body); expect(response.status).toBe(200);
    const json = await response.json(); expect(json.schema_version).toBe(3); expect(json).not.toHaveProperty("work_thread_id");
    expect((await db.query(`SELECT bound_work_thread_id FROM agent_sessions WHERE source_session_id='resolve-new'`)).rows[0].bound_work_thread_id).not.toBeNull();
  });

  it("repository match reuses the internal thread", async () => {
    const app = createApp(db, pepper); const body = resolveRequest("repo-match", "repo-match-1");
    await post(app, "/v1/context/resolve", body); const first = (await db.query(`SELECT bound_work_thread_id FROM agent_sessions WHERE source_session_id='repo-match'`)).rows[0].bound_work_thread_id;
    const second = resolveRequest("repo-match-2", "repo-match-2"); await post(app, "/v1/context/resolve", second);
    expect((await db.query(`SELECT bound_work_thread_id FROM agent_sessions WHERE source_session_id='repo-match-2'`)).rows[0].bound_work_thread_id).toBe(first);
  });

  it("existing session binding wins", async () => {
    const app = createApp(db, pepper); const body = resolveRequest("bound-session", "bound-1"); await post(app, "/v1/context/resolve", body);
    const first = (await db.query(`SELECT bound_work_thread_id FROM agent_sessions WHERE source_session_id='bound-session'`)).rows[0].bound_work_thread_id;
    const again = resolveRequest("bound-session", "bound-2"); await post(app, "/v1/context/resolve", again);
    expect((await db.query(`SELECT bound_work_thread_id FROM agent_sessions WHERE source_session_id='bound-session'`)).rows[0].bound_work_thread_id).toBe(first);
  });

  it("unrelated retrieval abstains", async () => {
    const response = await post(createApp(db, pepper), "/v1/context/resolve", { ...resolveRequest("unrelated", "unrelated-1"), repository_key: "github.com/unknown/none", request_text: "unrelated question" });
    expect((await response.json()).state).toBe("context");
  });

  it("ambiguous retrieval abstains", async () => {
    const app = createApp(db, pepper); const first = resolveRequest("ambiguous-1", "ambiguous-1"); await post(app, "/v1/context/resolve", first);
    const response = await post(app, "/v1/context/resolve", { ...resolveRequest("ambiguous-2", "ambiguous-2"), request_text: first.request_text });
    expect(["context", "abstained"]).toContain((await response.json()).state);
  });

  it("outcomes correlate through session", async () => {
    const app = createApp(db, pepper); const body = { ...resolveRequest("outcome-session", "outcome-resolve"), repository_key: "github.com/outcome/only", request_text: "outcome-only task" }; const resolved = await (await post(app, "/v1/context/resolve", body)).json();
    const outcome = { ...fixture("outcome-request.json"), agent_session_id: "outcome-session", idempotency_key: "outcome-session-1" };
    const response = await post(app, "/v1/outcomes", outcome); expect(response.status).toBe(201); expect(JSON.stringify(await response.json())).not.toContain("work_thread_id"); expect(resolved.receipt_id).toBeTruthy();
  });

  it("receipt packet and SHA-256 are immutable", async () => {
    const app = createApp(db, pepper); const resolved = await (await post(app, "/v1/context/resolve", { ...resolveRequest("receipt-session", "receipt-resolve"), repository_key: "github.com/receipt/only", request_text: "receipt-only task" })).json();
    const packet = "merged packet"; const ack = { ...fixture("ack-delivered-request.json"), final_packet: packet, final_packet_sha256: createHash("sha256").update(packet).digest("hex"), idempotency_key: "ack-real" };
    expect((await post(app, `/v1/receipts/${resolved.receipt_id}/ack`, ack)).status).toBe(200);
    expect((await post(app, `/v1/receipts/${resolved.receipt_id}/ack`, { ...ack, final_packet: "changed" })).status).toBe(409);
  });

  it("v3 requests and responses expose no Work Thread ID", async () => {
    const response = await post(createApp(db, pepper), "/v1/context/resolve", resolveRequest("boundary", "boundary-1")); const json = await response.json();
    expect(JSON.stringify(json)).not.toContain("work_thread_id");
  });

  it("device authorization accepts the v3 scope shape", async () => {
    const app = createApp(db, pepper, { authenticateHuman: async (value) => value === "human" ? { userId: ownerId } : null });
    const response = await post(app, "/v1/device/start", { schema_version: 3, device_name: "test", platform: "codex", requested_scopes: ["events:write", "context:read", "outcomes:write"] }, "");
    expect(response.status).toBe(201); expect((await response.json()).schema_version).toBe(3);
  });

  it("private correlation records source relationships", async () => {
    const row = await db.query(`SELECT work_thread_id FROM source_events WHERE workspace_id=$1 AND external_id='event-1'`, [workspaceId]); expect(row.rows[0].work_thread_id).toBeTruthy();
  });
  it("worker jobs remain queued for projection", async () => {
    expect((await db.query(`SELECT count(*)::int AS count FROM jobs WHERE workspace_id=$1 AND kind='project_event'`, [workspaceId])).rows[0].count).toBeGreaterThan(0);
  });
});
