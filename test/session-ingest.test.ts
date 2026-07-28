import { describe, expect, it } from "vitest";
import { issueAgentCredential } from "../src/agent-auth.js";
import { createApp } from "../src/server.js";

const pepper = "session-ingest-test-pepper-value-32-bytes";
const workspaceId = "10000000-0000-4000-8000-000000000001";
const body = {
  workspace_id: workspaceId,
  repository: "github.com/acme/app",
  external_session_id: "session-1",
  agent_type: "codex",
  branch: "main",
  summary_json: { current_status: "completed" },
  started_at: "2026-07-28T10:00:00.000Z",
  completed_at: "2026-07-28T10:10:00.000Z",
};

describe("POST /api/v1/ingest/session", () => {
  it("authenticates, rejects another workspace, and upserts the session", async () => {
    const credential = issueAgentCredential(pepper);
    let writes = 0;
    const db = { query: async (sql: string) => {
      if (sql.includes("SELECT auth.*")) return { rows: [{ id: "credential-1", workspace_id: workspaceId, agent_identity_id: "agent-1", secret_hash: credential.secretHash, scopes: ["events:write"], kind: "codex", auth_kind: "credential", context_delivery_enabled: true }], rowCount: 1 };
      if (sql.includes("INSERT INTO agent_sessions")) { writes += 1; return { rows: [{ id: "stored-session-1" }], rowCount: 1 }; }
      return { rows: [], rowCount: 1 };
    } } as any;
    const app = createApp(db, pepper);
    const post = (payload: unknown) => app.request("/api/v1/ingest/session", { method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });

    expect((await post({ ...body, workspace_id: "20000000-0000-4000-8000-000000000002" })).status).toBe(403);
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ session_id: "stored-session-1" });
    expect(writes).toBe(1);
  });
});
