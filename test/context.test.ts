import { describe, expect, it } from "vitest";
import { issueAgentCredential } from "../src/agent-auth.js";
import { createApp } from "../src/server.js";

describe("POST /api/v1/context", () => {
  it("returns a bounded memory briefing", async () => {
    const pepper = "context-test-pepper-value-32-bytes";
    const credential = issueAgentCredential(pepper);
    const db = { query: async (sql: string) => {
      if (sql.includes("SELECT auth.*")) return { rows: [{ id: "credential-1", workspace_id: "10000000-0000-4000-8000-000000000001", agent_identity_id: "agent-1", secret_hash: credential.secretHash, scopes: ["context:read"], kind: "codex", auth_kind: "credential", context_delivery_enabled: true }], rowCount: 1 };
      if (sql.includes("FROM memories m")) return { rows: [{ id: "memory-1", memory_type: "decision", content: "x".repeat(4_000), repository_id: "github.com/acme/app", status: "active", event_at: new Date("2026-07-28T10:00:00Z") }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    } } as any;
    const response = await createApp(db, pepper).request("/api/v1/context", { method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" }, body: JSON.stringify({ task: "login", repository: "github.com/acme/app", branch: "main" }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { briefing: string; sources: unknown[] };
    expect(body.briefing.length).toBe(3_000);
    expect(body.sources).toHaveLength(1);
  });
});
