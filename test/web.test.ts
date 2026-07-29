import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";

const db = {
  query: async () => ({ rows: [], rowCount: 0 }),
  end: async () => undefined,
} as never;

describe("hosted web app", () => {
  it("keeps authentication secrets on the server", async () => {
    const app = createApp(db, "x".repeat(32), {
      webAuth: {
        supabaseUrl: "https://example.supabase.co",
        anonKey: "public-anon-key",
      },
    });
    const response = await app.request("/app-config.json");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      auth_configured: true,
      demo_mode: false,
      connectors: [],
    });
  });

  it("does not invent auth configuration", async () => {
    const app = createApp(db, "x".repeat(32));
    expect(await (await app.request("/app-config.json")).json()).toEqual({
      auth_configured: false,
      demo_mode: false,
      connectors: [],
    });
  });

  it("enables local demo login only when explicitly configured", async () => {
    const app = createApp(db, "x".repeat(32), {
      demoUserId: "00000000-0000-4000-8000-000000000001",
    });
    expect(await (await app.request("/app-config.json")).json()).toMatchObject({
      demo_mode: true,
    });
    const login = await app.request("/auth/demo", { method: "POST" });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("termyte_session=demo");
    const logout = await app.request("/auth/logout", { method: "POST" });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("termyte_session=");
  });

  it("serves the dashboard and its versioned assets", async () => {
    const app = createApp(db, "x".repeat(32));
    const [page, device, script, styles] = await Promise.all([
      app.request("/"),
      app.request("/device?code=ABCD-2345"),
      app.request("/assets/app.js?v=3"),
      app.request("/assets/styles.css?v=4"),
    ]);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>Termyte</title>");
    expect(html).toContain('data-view="threads"');
    expect(device.status).toBe(200);
    expect(script.status).toBe(200);
    const javascript = await script.text();
    expect(javascript).toContain("Work Threads");
    expect(javascript).toContain("Linear defines the task");
    expect(javascript).not.toContain("access_token");
    expect(javascript).not.toContain("termyte-session");
    expect(javascript).not.toContain('<option value="custom">');
    expect(javascript).not.toContain('<option value="opencode">');
    expect(styles.status).toBe(200);
    expect(await styles.text()).toContain("[hidden] { display: none !important; }");
  });

  it("sets an HttpOnly cookie without exposing the Supabase token", async () => {
    const app = createApp(db, "x".repeat(32), {
      publicAppUrl: "https://app.termyte.dev",
      webAuth: {
        supabaseUrl: "https://example.supabase.co",
        anonKey: "server-anon-key",
        fetcher: async () => new Response(JSON.stringify({ access_token: "secret-token", user: { email: "founder@example.com" } }), { status: 200, headers: { "content-type": "application/json" } }),
      },
    });
    const response = await app.request("/auth/login", {
      method: "POST",
      headers: { origin: "https://app.termyte.dev", "content-type": "application/json" },
      body: JSON.stringify({ email: "founder@example.com", password: "long-enough" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("termyte_session=secret-token");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(JSON.stringify(await response.json())).not.toContain("secret-token");
  });

  it("rejects cookie-authenticated mutations from another origin", async () => {
    const app = createApp(db, "x".repeat(32), { demoUserId: "00000000-0000-4000-8000-000000000001", publicAppUrl: "https://app.termyte.dev" });
    const response = await app.request("/v1/admin/workspaces", {
      method: "POST",
      headers: { cookie: "termyte_session=demo", origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad", slug: "bad" }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects unsupported Agent Identity kinds before persistence", async () => {
    const app = createApp(db, "x".repeat(32), {
      authenticateHuman: async () => ({ userId: crypto.randomUUID() }),
    });
    const response = await app.request("/v1/admin/agents", {
      method: "POST",
      headers: {
        authorization: "Bearer human",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspace_id: crypto.randomUUID(),
        name: "Generic agent",
        kind: "custom",
      }),
    });
    expect(response.status).toBe(400);
  });

  it("lists recent memories for an authenticated workspace", async () => {
    const workspaceId = crypto.randomUUID();
    const app = createApp({ query: async (sql: string) => ({ rows: sql.includes("FROM memories m") ? [{ id: "memory-1", memory_type: "decision", content: "Use SQLite offline", repository_id: "github.com/acme/app", status: "active", event_at: new Date(), created_at: new Date() }] : [], rowCount: 1 }) } as any, "x".repeat(32), { authenticateHuman: async (token) => token === "human" ? { userId: "user-1" } : null });
    const response = await app.request(`/api/admin/memories?workspace_id=${workspaceId}`, { headers: { authorization: "Bearer human" } });
    expect(response.status).toBe(200);
    expect((await response.json() as { memories: unknown[] }).memories).toHaveLength(1);
  });

  it("rejects oversized connector webhooks before parsing them", async () => {
    const app = createApp(db, "x".repeat(32), {
      connectorRuntime: {
        encryptionKey: Buffer.alloc(32),
        webhookSecrets: { github: "github-webhook-secret" },
      },
    });
    const response = await app.request("/webhooks/connectors/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(2 * 1024 * 1024 + 1),
    });
    expect(response.status).toBe(413);
  });
});
