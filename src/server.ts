import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Handler } from "hono";
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
import { enqueueExtractionJob } from "./worker.js";

type Variables = { principal: AgentPrincipal; humanUserId: string; requestId: string };
const SessionIngestSchema = z.object({
  workspace_id: z.string().uuid(),
  repository: z.string().trim().min(1).max(2_000),
  external_session_id: z.string().trim().min(1).max(200),
  agent_type: z.enum(["codex", "claude-code"]),
  branch: z.string().trim().min(1).max(2_000).nullable(),
  summary_json: z.record(z.string(), z.unknown()),
  started_at: z.string().datetime({ offset: true }),
  completed_at: z.string().datetime({ offset: true }),
}).strict();
const ContextRequestSchema = z.object({
  task: z.string().trim().min(1).max(2_000),
  repository: z.string().trim().min(1).max(2_000),
  branch: z.string().trim().min(1).max(2_000).optional(),
  issue_or_pr: z.string().trim().min(1).max(2_000).optional(),
}).strict();
export interface CreateAppOptions {
  authenticateHuman?: HumanAuthenticator;
  demoUserId?: string;
  webAuth?: { supabaseUrl: string; anonKey: string };
  publicAppUrl?: string;
  metricsToken?: string;
  connectorRuntime?: ConnectorRuntime;
  extractionVersion?: string;
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
  app.use("/webhooks/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.use("/v1/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.use("/api/v1/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));

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

  const webhookHandler = (fixedProvider?: ConnectorProvider): Handler<{ Variables: Variables }> => async (c) => {
    const provider = fixedProvider ?? c.req.param("provider") as ConnectorProvider;
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
    return c.json({ received: true, ...(await ingestConnectorWebhook(db, event, options.extractionVersion ?? "v1")) });
  };
  app.post("/webhooks/connectors/:provider", webhookHandler());
  app.post("/webhooks/github", webhookHandler("github"));
  app.post("/webhooks/slack", webhookHandler("slack"));
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
  app.use("/api/v1/*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    const principal = await authenticateAgent(db, token, pepper);
    if (!principal) return c.json(error("UNAUTHENTICATED", "Invalid agent credential", c.get("requestId")), 401);
    c.set("principal", principal); return next();
  });
  app.use("/api/admin/*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    const human = token === "demo" && options.demoUserId ? { userId: options.demoUserId } : options.authenticateHuman ? await options.authenticateHuman(token) : null;
    if (!human) return c.json(error("UNAUTHENTICATED", "Invalid user session", c.get("requestId")), 401);
    c.set("humanUserId", human.userId); return next();
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
  app.get("/api/admin/memories", async (c) => {
    const workspaceId = z.string().uuid().parse(c.req.query("workspace_id"));
    const rows = (await db.query(`
      SELECT m.id, m.memory_type, m.content, m.repository_id, m.status, m.event_at, m.created_at
      FROM memories m
      JOIN workspace_memberships wm ON wm.workspace_id = m.workspace_id
      WHERE m.workspace_id = $1 AND wm.user_id = $2 AND wm.revoked_at IS NULL
      ORDER BY m.created_at DESC LIMIT 50
    `, [workspaceId, c.get("humanUserId")])).rows;
    return c.json({ memories: rows });
  });

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
  app.post("/api/v1/ingest/session", async (c) => {
    const principal = c.get("principal");
    if (!hasScope(principal, "events:write")) return c.json(error("FORBIDDEN", "Credential lacks events:write", c.get("requestId")), 403);
    const input = SessionIngestSchema.parse(await c.req.json());
    if (input.workspace_id !== principal.workspaceId) return c.json(error("FORBIDDEN", "Workspace mismatch", c.get("requestId")), 403);
    if (input.agent_type !== principal.platform) return c.json(error("INVALID_ARGUMENT", "Agent type mismatch", c.get("requestId")), 400);
    const id = crypto.randomUUID();
    const row = (await db.query<{ id: string }>(`
      INSERT INTO agent_sessions
        (id, workspace_id, external_session_id, agent_type, repository_id, branch, summary_json, status, started_at, completed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, $9)
      ON CONFLICT (workspace_id, external_session_id) DO UPDATE SET
        repository_id = EXCLUDED.repository_id,
        branch = EXCLUDED.branch,
        summary_json = EXCLUDED.summary_json,
        status = EXCLUDED.status,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at
      RETURNING id
    `, [id, input.workspace_id, input.external_session_id, input.agent_type, input.repository, input.branch, input.summary_json, input.started_at, input.completed_at])).rows[0];
    await enqueueExtractionJob(db, input.workspace_id, "agent_session", row!.id, options.extractionVersion ?? "v1");
    return c.json({ session_id: row!.id }, 201);
  });
  app.post("/api/v1/context", async (c) => {
    const principal = c.get("principal");
    if (!hasScope(principal, "context:read")) return c.json(error("FORBIDDEN", "Credential lacks context:read", c.get("requestId")), 403);
    const input = ContextRequestSchema.parse(await c.req.json());
    const memories = (await db.query<{ id: string; memory_type: string; content: string; repository_id: string | null; status: string; event_at: Date }>(`
      SELECT m.id, m.memory_type, m.content, m.repository_id, m.status, m.event_at
      FROM memories m
      WHERE m.workspace_id = $1 AND m.repository_id = $2 AND m.status IN ('active', 'superseded')
      ORDER BY
        CASE WHEN $3::text IS NOT NULL AND (m.work_thread_id = $3 OR m.content ILIKE '%' || $3 || '%') THEN 0 ELSE 1 END,
        CASE WHEN $4::text IS NOT NULL AND EXISTS (
          SELECT 1 FROM memory_sources ms JOIN agent_sessions s ON s.id = ms.agent_session_id
          WHERE ms.memory_id = m.id AND s.branch = $4
        ) THEN 0 ELSE 1 END,
        CASE WHEN m.content ILIKE '%' || $5 || '%' THEN 0 ELSE 1 END,
        m.event_at DESC
      LIMIT 50
    `, [principal.workspaceId, input.repository, input.issue_or_pr ?? null, input.branch ?? null, input.task])).rows;
    let briefing = memories.map((memory) => `[${memory.memory_type}] ${memory.content}`).join("\n");
    if (briefing.length > 3_000) briefing = `${briefing.slice(0, 2_997)}...`;
    return c.json({ briefing, sources: memories.map((memory) => ({ memory_id: memory.id, memory_type: memory.memory_type, repository: memory.repository_id, status: memory.status, event_at: memory.event_at })) });
  });

  app.onError((err, c) => { if (err instanceof HTTPException) return err.getResponse(); if (err instanceof z.ZodError || err instanceof SyntaxError) return c.json(error("INVALID_ARGUMENT", "Invalid request", c.get("requestId")), 400); return c.json(error("INTERNAL", "Internal server error", c.get("requestId")), 500); });
  return app;
}

function error(code: string, message: string, requestId: string) { return { schema_version: TERMYTE_PROTOCOL_VERSION, error: { code, message, request_id: requestId } }; }

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const config = loadConfig();
  const db = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const app = createApp(db, config.AGENT_TOKEN_PEPPER, { publicAppUrl: config.PUBLIC_APP_URL, metricsToken: undefined, extractionVersion: config.EXTRACTION_VERSION, connectorRuntime: { encryptionKey: connectorKey(config.CONNECTOR_ENCRYPTION_KEY ?? ""), webhookSecrets: { github: config.GITHUB_WEBHOOK_SECRET, slack: config.SLACK_SIGNING_SECRET } } });
  serve({ fetch: app.fetch, port: config.PORT });
}
