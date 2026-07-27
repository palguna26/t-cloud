import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import {
  DeviceAuthorizationStartRequestSchema,
  EventBatchRequestSchema,
  ReportOutcomeRequestSchema,
  ResolveContextRequestSchema,
  TERMYTE_PROTOCOL_VERSION,
  parseProtocol,
} from "termyte/protocol";
import { redactValue } from "termyte/security/redaction";
import { z } from "zod";
import { resolveAlphaContext, storeAlphaEvents, storeAlphaOutcome } from "./alpha.js";
import { authenticateAgent, hasScope, type AgentPrincipal } from "./agent-auth.js";
import { loadConfig } from "./config.js";
import { createDatabase, type Database } from "./db.js";
import {
  CONNECTOR_PROVIDERS,
  connectorKey,
  finishConnectorOAuth,
  ingestConnectorWebhook,
  listConnectors,
  mapConnectorScope,
  normalizeConnectorWebhook,
  revokeConnector,
  startConnectorOAuth,
  verifyConnectorWebhook,
  type ConnectorProvider,
  type ConnectorRuntime,
} from "./connectors.js";
import { approveDeviceAuthorization, exchangeDeviceAuthorization, startDeviceAuthorization } from "./device-auth.js";
import { createSupabaseHumanAuthenticator, type HumanAuthenticator } from "./human-auth.js";
import { createAgentIdentity, createWorkspace, listAgents, listWorkspaces } from "./admin.js";
import { consumeRateLimit } from "./rate-limit.js";
import { ServiceMetrics } from "./metrics.js";

type Variables = { principal: AgentPrincipal; humanUserId: string; requestId: string };
export interface CreateAppOptions {
  authenticateHuman?: HumanAuthenticator;
  demoUserId?: string;
  webAuth?: { supabaseUrl: string; anonKey: string };
  publicAppUrl?: string;
  metricsToken?: string;
  connectorRuntime?: ConnectorRuntime;
}

export function createApp(db: Database, pepper: string, options: CreateAppOptions = {}) {
  const app = new Hono<{ Variables: Variables }>();
  const metrics = new ServiceMetrics();
  app.use("*", async (context, next) => {
    const started = performance.now();
    context.set("requestId", context.req.header("x-request-id") ?? crypto.randomUUID());
    await next();
    context.header("x-request-id", context.get("requestId"));
    metrics.recordRequest(context.req.method, context.req.path, context.res.status, performance.now() - started);
  });
  app.use("/v1/*", cors({
    origin: new URL(options.publicAppUrl ?? "http://localhost:3000").origin,
    allowHeaders: ["authorization", "content-type", "x-request-id"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    exposeHeaders: ["x-request-id"],
    maxAge: 600,
  }));
  app.use("/webhooks/connectors/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.use("/v1/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));

  app.get("/health", async (c) => { await db.query("SELECT 1"); return c.json({ ok: true }); });
  app.get("/app-config.json", (c) => c.json({ supabase_url: options.webAuth?.supabaseUrl ?? null, supabase_anon_key: options.webAuth?.anonKey ?? null, demo_mode: Boolean(options.demoUserId) }));
  app.get("/", serveStatic({ path: "./web/index.html" }));
  app.get("/device", serveStatic({ path: "./web/index.html" }));
  app.get("/connect", serveStatic({ path: "./web/index.html" }));
  app.use("/assets/*", serveStatic({ root: "./web", rewriteRequestPath: (path) => path.replace(/^\/assets/, "") }));
  app.get("/metrics", async (c) => {
    if (options.metricsToken && c.req.header("authorization") !== `Bearer ${options.metricsToken}`) return c.text("Unauthorized\n", 401);
    const row = (await db.query<{ pending: number; failed: number; dead: number; oldest_pending_seconds: number }>(`SELECT count(*) FILTER (WHERE state='pending')::integer AS pending,count(*) FILTER (WHERE state='failed')::integer AS failed,0::integer AS dead,coalesce(extract(epoch FROM now()-min(created_at) FILTER (WHERE state IN ('pending','failed'))),0)::float8 AS oldest_pending_seconds FROM alpha_sync_jobs`)).rows[0] ?? { pending: 0, failed: 0, dead: 0, oldest_pending_seconds: 0 };
    return c.text(metrics.render({ pending: row.pending, failed: row.failed, dead: row.dead, oldestPendingSeconds: row.oldest_pending_seconds }), 200, { "content-type": "text/plain; version=0.0.4" });
  });

  app.post("/webhooks/connectors/:provider", async (c) => {
    const provider = c.req.param("provider") as ConnectorProvider;
    if (!CONNECTOR_PROVIDERS.includes(provider)) return c.json({ received: false }, 404);
    const secret = options.connectorRuntime?.webhookSecrets[provider];
    if (!secret) return c.json({ received: false }, 503);
    const raw = await c.req.text();
    if (!verifyConnectorWebhook(provider, raw, c.req.raw.headers, secret)) return c.json({ received: false }, 401);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return c.json({ received: false }, 400); }
    if (provider === "slack" && body.type === "url_verification") return c.json({ challenge: body.challenge });
    const event = normalizeConnectorWebhook(provider, body, c.req.raw.headers);
    if (!event) return c.json({ received: true, ignored: true });
    return c.json({ received: true, ...(await ingestConnectorWebhook(db, event)) });
  });
  app.get("/v1/connectors/oauth/callback", async (c) => {
    if (!options.connectorRuntime) return c.text("Connectors are not configured", 503);
    const provider = z.enum(CONNECTOR_PROVIDERS).parse(c.req.query("provider"));
    await finishConnectorOAuth(db, provider, { state: z.string().parse(c.req.query("state")), code: c.req.query("code"), installationId: c.req.query("installation_id") }, options.publicAppUrl ?? "http://localhost:3000", options.connectorRuntime);
    return c.redirect(new URL(`/?connected=${provider}`, options.publicAppUrl ?? "http://localhost:3000").toString());
  });

  app.use("/v1/*", async (c, next) => {
    if (["/v1/device/start", "/v1/device/token", "/v1/connectors/oauth/callback"].includes(c.req.path)) return next();
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (c.req.path.startsWith("/v1/admin/")) {
      const human = token === "demo" && options.demoUserId ? { userId: options.demoUserId } : options.authenticateHuman ? await options.authenticateHuman(token) : null;
      if (!human) return c.json(error("UNAUTHENTICATED", "Invalid user session", c.get("requestId")), 401);
      c.set("humanUserId", human.userId); return next();
    }
    const principal = await authenticateAgent(db, token, pepper);
    if (!principal) return c.json(error("UNAUTHENTICATED", "Invalid agent credential", c.get("requestId")), 401);
    c.set("principal", principal); return next();
  });

  app.post("/v1/device/start", async (c) => {
    if (!await consumeRateLimit(db, `device-start:${c.req.header("x-forwarded-for") ?? "unknown"}`, 20, 600)) return c.json(error("RATE_LIMITED", "Too many requests", c.get("requestId")), 429);
    try { return c.json(await startDeviceAuthorization(db, pepper, options.publicAppUrl ?? "http://localhost:3000", parseProtocol(DeviceAuthorizationStartRequestSchema, await c.req.json())), 201); } catch (e) { if (e instanceof z.ZodError || e instanceof SyntaxError) return c.json(error("INVALID_ARGUMENT", "Invalid device request", c.get("requestId")), 400); throw e; }
  });
  app.post("/v1/device/token", async (c) => {
    try { const body = z.object({ device_code: z.string() }).parse(await c.req.json()); return c.json(await exchangeDeviceAuthorization(db, pepper, body.device_code)); } catch (e) { if (e instanceof z.ZodError || e instanceof SyntaxError) return c.json(error("INVALID_ARGUMENT", "Invalid device request", c.get("requestId")), 400); throw e; }
  });
  app.post("/v1/admin/device/approve", async (c) => {
    const input = z.object({ user_code: z.string(), workspace_id: z.string().uuid(), agent_identity_id: z.string().uuid().optional(), agent_name: z.string().optional() }).parse(await c.req.json());
    return c.json(await approveDeviceAuthorization(db, c.get("humanUserId"), input));
  });

  app.get("/v1/admin/workspaces", async (c) => c.json(await listWorkspaces(db, c.get("humanUserId"))));
  app.post("/v1/admin/workspaces", async (c) => c.json(await createWorkspace(db, c.get("humanUserId"), z.object({ name: z.string().min(1), slug: z.string().min(1) }).parse(await c.req.json())), 201));
  app.get("/v1/admin/agents", async (c) => c.json(await listAgents(db, c.get("humanUserId"), z.string().uuid().parse(c.req.query("workspace_id")))));
  app.post("/v1/admin/agents", async (c) => c.json(await createAgentIdentity(db, c.get("humanUserId"), z.string().uuid().parse(c.req.query("workspace_id")), z.object({ name: z.string().min(1), kind: z.enum(["codex", "claude-code"]) }).parse(await c.req.json())), 201));
  app.get("/v1/admin/connectors", async (c) => c.json(await listConnectors(db, c.get("humanUserId"), z.string().uuid().parse(c.req.query("workspace_id")))));
  app.post("/v1/admin/connectors/:provider/start", async (c) => c.json(await startConnectorOAuth(db, c.get("humanUserId"), z.string().uuid().parse(c.req.query("workspace_id")), z.enum(CONNECTOR_PROVIDERS).parse(c.req.param("provider")), [], options.publicAppUrl ?? "http://localhost:3000", options.connectorRuntime!)));
  app.post("/v1/admin/connectors/:id/scopes", async (c) => { const input = z.object({ external_scope_id: z.string(), external_scope_name: z.string(), repository_key: z.string() }).parse(await c.req.json()); return c.json(await mapConnectorScope(db, c.get("humanUserId"), z.string().uuid().parse(c.req.query("workspace_id")), c.req.param("id"), { externalScopeId: input.external_scope_id, externalScopeName: input.external_scope_name, repositoryKey: input.repository_key })); });
  app.post("/v1/admin/connectors/:id/revoke", async (c) => c.json(await revokeConnector(db, c.get("humanUserId"), z.string().uuid().parse(c.req.query("workspace_id")), c.req.param("id"))));

  app.post("/v1/events/batch", async (c) => {
    const principal = c.get("principal");
    if (!hasScope(principal, "events:write")) return c.json(error("FORBIDDEN", "Credential lacks events:write", c.get("requestId")), 403);
    const parsed = parseProtocol(EventBatchRequestSchema, await c.req.json());
    const events = parsed.events.map((event) => redactValue(event, "event").value) as any[];
    if (events.some((event) => event.source.platform !== principal.platform)) return c.json(error("INVALID_ARGUMENT", "Platform mismatch", c.get("requestId")), 400);
    const result = await storeAlphaEvents(db, principal, events);
    return c.json({ schema_version: TERMYTE_PROTOCOL_VERSION, accepted_event_ids: result.accepted, existing_event_ids: result.existing });
  });
  app.post("/v1/context/resolve", async (c) => {
    const principal = c.get("principal"); if (!hasScope(principal, "context:read")) return c.json(error("FORBIDDEN", "Credential lacks context:read", c.get("requestId")), 403);
    return c.json(await resolveAlphaContext(db, principal, parseProtocol(ResolveContextRequestSchema, await c.req.json())));
  });
  app.post("/v1/receipts/:id/ack", async (c) => c.json(error("NOT_FOUND", "Receipt acknowledgement is not part of alpha", c.get("requestId")), 404));
  app.post("/v1/outcomes", async (c) => {
    const principal = c.get("principal"); if (!hasScope(principal, "outcomes:write")) return c.json(error("FORBIDDEN", "Credential lacks outcomes:write", c.get("requestId")), 403);
    await storeAlphaOutcome(db, principal, parseProtocol(ReportOutcomeRequestSchema, await c.req.json()));
    return c.json({ schema_version: TERMYTE_PROTOCOL_VERSION, accepted: true }, 201);
  });

  app.onError((err, c) => { if (err instanceof HTTPException) return err.getResponse(); if (err instanceof z.ZodError || err instanceof SyntaxError) return c.json(error("INVALID_ARGUMENT", "Invalid request", c.get("requestId")), 400); return c.json(error("INTERNAL", "Internal server error", c.get("requestId")), 500); });
  return app;
}

function error(code: string, message: string, requestId: string) { return { schema_version: TERMYTE_PROTOCOL_VERSION, error: { code, message, request_id: requestId } }; }

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const config = loadConfig();
  const db = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const app = createApp(db, config.AGENT_TOKEN_PEPPER, { publicAppUrl: config.PUBLIC_APP_URL, metricsToken: undefined, connectorRuntime: { encryptionKey: connectorKey(config.CONNECTOR_ENCRYPTION_KEY ?? ""), webhookSecrets: { github: config.GITHUB_WEBHOOK_SECRET, slack: config.SLACK_SIGNING_SECRET } } });
  serve({ fetch: app.fetch, port: config.PORT });
}
