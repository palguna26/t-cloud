import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";

const db = {
  query: async () => ({ rows: [], rowCount: 0 }),
  end: async () => undefined,
} as never;

describe("hosted web app", () => {
  it("publishes browser-safe authentication configuration", async () => {
    const app = createApp(db, "x".repeat(32), {
      webAuth: {
        supabaseUrl: "https://example.supabase.co",
        anonKey: "public-anon-key",
      },
    });
    const response = await app.request("/app-config.json");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      supabase_url: "https://example.supabase.co",
      supabase_anon_key: "public-anon-key",
      demo_mode: false,
    });
  });

  it("does not invent auth configuration", async () => {
    const app = createApp(db, "x".repeat(32));
    expect(await (await app.request("/app-config.json")).json()).toEqual({
      supabase_url: null,
      supabase_anon_key: null,
      demo_mode: false,
    });
  });

  it("enables local demo login only when explicitly configured", async () => {
    const app = createApp(db, "x".repeat(32), {
      demoUserId: "00000000-0000-4000-8000-000000000001",
    });
    expect(await (await app.request("/app-config.json")).json()).toMatchObject({
      demo_mode: true,
    });
  });

  it("serves the dashboard and its versioned assets", async () => {
    const app = createApp(db, "x".repeat(32));
    const [page, device, script, styles] = await Promise.all([
      app.request("/"),
      app.request("/device?code=ABCD-2345"),
      app.request("/assets/app.js?v=2"),
      app.request("/assets/styles.css?v=2"),
    ]);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>Termyte</title>");
    expect(html).toContain('data-view="connections"');
    expect(device.status).toBe(200);
    expect(script.status).toBe(200);
    const javascript = await script.text();
    expect(javascript).toContain("function renderWork()");
    expect(javascript).toContain("function renderConnections()");
    expect(javascript).toContain("function openDeviceApproval()");
    expect(javascript).toContain('const userCode = new URLSearchParams(location.search).get("code")');
    expect(javascript).not.toContain('${["github", "slack", "linear"].map');
    expect(javascript).not.toContain('<option value="custom">');
    expect(javascript).not.toContain('<option value="opencode">');
    expect(styles.status).toBe(200);
    expect(await styles.text()).toContain("[hidden] { display: none !important; }");
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
