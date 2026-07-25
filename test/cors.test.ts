import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";

describe("web API boundary", () => {
  it("answers browser preflight only for the configured application origin", async () => {
    const db = {
      query: async () => ({ rows: [], rowCount: 0 }),
    } as any;
    const app = createApp(db, "test-pepper-at-least-thirty-two-characters", {
      publicAppUrl: "https://app.termyte.test",
    });

    const response = await app.request("/v1/admin/workspaces", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.termyte.test",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin"))
      .toBe("https://app.termyte.test");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("requires the configured bearer token for operational metrics", async () => {
    const db = {
      query: async () => ({
        rows: [{
          pending: 0,
          failed: 0,
          dead: 0,
          oldest_pending_seconds: 0,
        }],
        rowCount: 1,
      }),
    } as any;
    const token = "metrics-test-token-at-least-thirty-two-characters";
    const app = createApp(db, "test-pepper-at-least-thirty-two-characters", {
      metricsToken: token,
    });

    expect((await app.request("/metrics")).status).toBe(401);
    expect((await app.request("/metrics", {
      headers: { authorization: `Bearer ${token}` },
    })).status).toBe(200);
  });
});
