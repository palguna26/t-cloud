import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import {
  AcknowledgeReceiptRequestSchema,
  EventBatchRequestSchema,
  DeviceAuthorizationStartRequestSchema,
  ReportOutcomeRequestSchema,
  ResolveContextRequestSchema,
  TERMYTE_PROTOCOL_VERSION,
  parseProtocol,
} from "termyte/protocol";
import {
  ClaimHandoffRequestSchema,
  CreateHandoffRequestSchema,
  CreateWorkRequestSchema,
  DeviceAuthorizationPollRequestSchema,
  RefreshContextRequestSchema,
} from "./legacy-protocol.js";
import { redactValue } from "termyte/security/redaction";
import { z } from "zod";
import { authenticateAgent, hasScope, type AgentPrincipal } from "./agent-auth.js";
import { loadConfig } from "./config.js";
import { createDatabase, transaction, type Database } from "./db.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  acknowledgeReceipt,
  claimHandoff,
  createHandoff,
  createWork,
  reportOutcome,
  resolveContext,
  refreshContext,
  sessionId,
} from "./work.js";
import {
  approveDeviceAuthorization,
  exchangeDeviceAuthorization,
  startDeviceAuthorization,
} from "./device-auth.js";
import {
  createSupabaseHumanAuthenticator,
  type HumanAuthenticator,
} from "./human-auth.js";
import {
  correctContextItem,
  createWorkspace,
  getReceipt,
  getWorkThread,
  listAgents,
  listWorkThreads,
  listWorkspaces,
  revokeDevice,
  exportWorkspace,
  setRetention,
  deleteSourceEvent,
  requestWorkspaceDeletion,
  addMember,
  createAgentCredential,
  createAgentIdentity,
  grantWorkThreadAccess,
  listAuditEvents,
  listMembers,
  removeMember,
  revokeAgentCredential,
  revokeWorkThreadAccess,
  rotateAgentCredential,
  setAgentStatus,
  restrictContextItem,
  mergeWorkThreads,
  splitWorkThread,
  setContextDelivery,
  previewContextBriefing,
  confirmOutcome,
  getWorkspaceUsage,
  acceptWorkspaceInvite,
  createWorkspaceInvite,
  listWorkspaceInvites,
  revokeWorkspaceInvite,
  listResolutionAttempts,
  resolveResolutionAttempt,
} from "./admin.js";
import { consumeRateLimit } from "./rate-limit.js";
import { ServiceMetrics } from "./metrics.js";
import {
  CONNECTOR_PROVIDERS,
  connectorKey,
  decideSourceLink,
  enqueueSlackThreadSync,
  finishConnectorOAuth,
  ingestConnectorWebhook,
  listConnectorAttention,
  listConnectors,
  mapConnectorScope,
  normalizeConnectorWebhook,
  revokeConnector,
  startConnectorOAuth,
  verifyConnectorWebhook,
  type ConnectorProvider,
  type ConnectorRuntime,
} from "./connectors.js";
import type { ContextLLMRuntime } from "./work.js";

type Variables = {
  principal: AgentPrincipal;
  requestId: string;
  humanUserId: string;
};

export interface CreateAppOptions {
  authenticateHuman?: HumanAuthenticator;
  demoUserId?: string;
  webAuth?: { supabaseUrl: string; anonKey: string };
  publicAppUrl?: string;
  metricsToken?: string;
  connectorRuntime?: ConnectorRuntime;
  contextLLM?: ContextLLMRuntime;
}

export function createApp(
  db: Database,
  pepper: string,
  options: CreateAppOptions = {},
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  const metrics = new ServiceMetrics();
  // PRD alpha surface: keep workspace/source/session views, but do not expose
  // the later Work Thread administration model.
  app.use("/v1/admin/*", async (context, next) => {
    const path = context.req.path;
    if (/\/(work-threads|receipts|outcomes|grants|resolution-attempts|audit|usage|export|retention|context-delivery|devices|credentials|members)(\/|$)/.test(path)) {
      return context.json({ error: "Not found" }, 404);
    }
    await next();
  });
  app.use("*", async (context, next) => {
    const startedAt = performance.now();
    context.set("requestId", context.req.header("x-request-id") ?? randomUUID());
    await next();
    context.header("x-request-id", context.get("requestId"));
    const latencyMs = performance.now() - startedAt;
    metrics.recordRequest(context.req.method, context.req.path, context.res.status, latencyMs);
    if (process.env.NODE_ENV !== "test") {
      const principal = context.get("principal");
      process.stdout.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        service: "termyte-api",
        request_id: context.get("requestId"),
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        latency_ms: Number(latencyMs.toFixed(1)),
        workspace_id: principal?.workspaceId,
        agent_identity_id: principal?.agentIdentityId,
      })}\n`);
    }
  });
  app.get("/health", async (context) => {
    await db.query("SELECT 1");
    return context.json({ ok: true });
  });
  app.get("/app-config.json", (context) => context.json({
    supabase_url: options.webAuth?.supabaseUrl ?? null,
    supabase_anon_key: options.webAuth?.anonKey ?? null,
    demo_mode: Boolean(options.demoUserId),
  }));
  app.use("/assets/*", serveStatic({
    root: "./web",
    rewriteRequestPath: (path) => path.replace(/^\/assets/, ""),
  }));
  app.get("/", serveStatic({ path: "./web/index.html" }));
  app.get("/device", serveStatic({ path: "./web/index.html" }));
  app.get("/invite", serveStatic({ path: "./web/index.html" }));
  app.get("/connect", serveStatic({ path: "./web/index.html" }));
  app.get("/metrics", async (context) => {
    if (options.metricsToken && !matchesBearer(
      context.req.header("authorization"),
      options.metricsToken,
    )) {
      return context.text("Unauthorized\n", 401);
    }
    const row = (await db.query<{
      pending: number;
      failed: number;
      dead: number;
      oldest_pending_seconds: number;
    }>(`
      SELECT
        count(*) FILTER (WHERE state = 'pending')::integer AS pending,
        count(*) FILTER (WHERE state = 'failed')::integer AS failed,
        count(*) FILTER (WHERE state = 'dead')::integer AS dead,
        coalesce(extract(epoch FROM now() - min(created_at)
          FILTER (WHERE state IN ('pending', 'failed'))), 0)::float8
          AS oldest_pending_seconds
      FROM jobs
    `)).rows[0]!;
    return context.text(metrics.render({
      pending: row.pending,
      failed: row.failed,
      dead: row.dead,
      oldestPendingSeconds: row.oldest_pending_seconds,
    }), 200, { "content-type": "text/plain; version=0.0.4" });
  });
  app.use("/v1/*", cors({
    origin: new URL(options.publicAppUrl ?? "http://localhost:3000").origin,
    allowHeaders: ["authorization", "content-type", "x-request-id"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    exposeHeaders: ["content-disposition", "x-request-id"],
    maxAge: 600,
  }));
  app.use("/webhooks/connectors/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.post("/webhooks/connectors/:provider", async (context) => {
    const provider = context.req.param("provider") as ConnectorProvider;
    if (!CONNECTOR_PROVIDERS.includes(provider)) {
      return context.json({ received: false }, 404);
    }
    const secret = options.connectorRuntime?.webhookSecrets[provider];
    if (!secret) return context.json({ received: false }, 503);
    const rawBody = await context.req.text();
    if (!verifyConnectorWebhook(provider, rawBody, context.req.raw.headers, secret)) {
      return context.json({ received: false }, 401);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return context.json({ received: false }, 400);
    }
    if (provider === "slack" && body["type"] === "url_verification") {
      return context.json({ challenge: body["challenge"] });
    }
    const event = normalizeConnectorWebhook(provider, body, context.req.raw.headers);
    if (!event) return context.json({ received: true, ignored: true });
    try {
      const result = provider === "slack"
        ? await enqueueSlackThreadSync(db, event)
        : await ingestConnectorWebhook(db, event);
      return context.json({ received: true, ...result });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return context.json({ received: false }, 404);
      }
      throw error;
    }
  });
  app.get("/v1/connectors/oauth/callback", async (context) => {
    if (!options.connectorRuntime) return context.text("Connectors are not configured", 503);
    const provider = z.enum(CONNECTOR_PROVIDERS).parse(context.req.query("provider"));
    const state = z.string().min(1).parse(context.req.query("state"));
    await finishConnectorOAuth(db, provider, {
      state,
      code: context.req.query("code"),
      installationId: context.req.query("installation_id"),
    }, options.publicAppUrl ?? "http://localhost:3000", options.connectorRuntime);
    return context.redirect(new URL("/?connected=" + provider, options.publicAppUrl ?? "http://localhost:3000"));
  });
  app.use("/v1/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.use("/v1/*", async (context, next) => {
    if (
      context.req.path === "/v1/device/start"
      || context.req.path === "/v1/device/token"
      || context.req.path === "/v1/connectors/oauth/callback"
    ) {
      await next();
      return;
    }
    const authorization = context.req.header("authorization");
    if (context.req.path.startsWith("/v1/admin/")) {
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      const human = token === "demo" && options.demoUserId
        ? { userId: options.demoUserId }
        : token && options.authenticateHuman
          ? await options.authenticateHuman(token)
          : null;
      if (!human) {
        return context.json(protocolError("UNAUTHENTICATED", "Invalid user session", context.get("requestId")), 401);
      }
      context.set("humanUserId", human.userId);
      await next();
      return;
    }
    const principal = authorization?.startsWith("Bearer ")
      ? await authenticateAgent(db, authorization.slice(7), pepper)
      : null;
    if (!principal) {
      return context.json(protocolError("UNAUTHENTICATED", "Invalid agent credential", context.get("requestId")), 401);
    }
    context.set("principal", principal);
    await next();
  });
  app.post("/v1/device/start", async (context) => {
    if (!await consumeRateLimit(db, `device-start:${clientAddress(context)}`, 20, 600)) {
      return context.json(protocolError(
        "RATE_LIMITED",
        "Too many device authorization requests",
        context.get("requestId"),
        true,
      ), 429);
    }
    try {
      const input = parseProtocol(
        DeviceAuthorizationStartRequestSchema,
        await context.req.json(),
      );
      return context.json(await startDeviceAuthorization(
        db,
        pepper,
        options.publicAppUrl ?? "http://localhost:3000",
        input,
      ), 201);
    } catch (error) {
      if (error instanceof SyntaxError || isValidationError(error)) {
        return context.json(protocolError("INVALID_ARGUMENT", "Invalid device request", context.get("requestId")), 400);
      }
      throw error;
    }
  });
  app.post("/v1/device/token", async (context) => {
    if (!await consumeRateLimit(db, `device-token:${clientAddress(context)}`, 120, 600)) {
      return context.json(protocolError(
        "RATE_LIMITED",
        "Too many device token requests",
        context.get("requestId"),
        true,
      ), 429);
    }
    try {
      const input = parseProtocol(
        DeviceAuthorizationPollRequestSchema,
        await context.req.json(),
      );
      return context.json(await exchangeDeviceAuthorization(db, pepper, input.device_code));
    } catch (error) {
      if (error instanceof SyntaxError || isValidationError(error)) {
        return context.json(protocolError("INVALID_ARGUMENT", "Invalid device code", context.get("requestId")), 400);
      }
      throw error;
    }
  });
  app.post("/v1/admin/device/approve", async (context) => {
    try {
      const input = z.object({
        user_code: z.string().regex(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/),
        workspace_id: z.string().uuid(),
        agent_identity_id: z.string().uuid().optional(),
        agent_name: z.string().trim().min(1).max(500).optional(),
      }).strict().parse(await context.req.json());
      return context.json(await approveDeviceAuthorization(
        db,
        context.get("humanUserId"),
        input,
      ));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        return context.json(protocolError("INVALID_ARGUMENT", "Invalid device approval", context.get("requestId")), 400);
      }
      throw error;
    }
  });
  app.post("/v1/admin/workspaces", async (context) => {
    const input = z.object({
      name: z.string().trim().min(1).max(200),
      slug: z.string().trim().min(2).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    }).strict().parse(await context.req.json());
    return context.json(await createWorkspace(db, context.get("humanUserId"), input), 201);
  });
  app.get("/v1/admin/workspaces", async (context) =>
    context.json({ workspaces: await listWorkspaces(db, context.get("humanUserId")) }));
  app.get("/v1/admin/usage", async (context) => {
    const workspaceId = z.string().uuid().parse(context.req.query("workspace_id"));
    return context.json(await getWorkspaceUsage(
      db,
      context.get("humanUserId"),
      workspaceId,
    ));
  });
  app.post("/v1/admin/invites", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      email: z.string().trim().email().max(320),
      role: z.enum(["admin", "member"]),
    }).strict().parse(await context.req.json());
    const invite = await createWorkspaceInvite(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      { email: input.email, role: input.role },
    );
    return context.json({
      ...invite,
      invite_url: new URL(
        `/invite?token=${encodeURIComponent(invite.token)}`,
        options.publicAppUrl ?? "http://localhost:3000",
      ).toString(),
    }, 201);
  });
  app.get("/v1/admin/invites", async (context) => {
    const workspaceId = z.string().uuid().parse(context.req.query("workspace_id"));
    return context.json({
      invites: await listWorkspaceInvites(
        db,
        context.get("humanUserId"),
        workspaceId,
      ),
    });
  });
  app.post("/v1/admin/invites/accept", async (context) => {
    const input = z.object({
      token: z.string().regex(/^tyt_inv_[A-Za-z0-9_-]{43}$/),
    }).strict().parse(await context.req.json());
    return context.json(await acceptWorkspaceInvite(
      db,
      context.get("humanUserId"),
      input.token,
    ));
  });
  app.post("/v1/admin/invites/:id/revoke", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
    }).strict().parse(await context.req.json());
    return context.json(await revokeWorkspaceInvite(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
    ));
  });
  app.get("/v1/admin/members", async (context) => {
    const workspaceId = z.string().uuid().parse(context.req.query("workspace_id"));
    return context.json({
      members: await listMembers(db, context.get("humanUserId"), workspaceId),
    });
  });
  app.post("/v1/admin/members", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      user_id: z.string().uuid(),
      role: z.enum(["admin", "member"]),
    }).strict().parse(await context.req.json());
    return context.json(await addMember(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      { userId: input.user_id, role: input.role },
    ), 201);
  });
  app.delete("/v1/admin/members/:id", async (context) => {
    const workspaceId = z.string().uuid().parse(context.req.query("workspace_id"));
    return context.json(await removeMember(
      db,
      context.get("humanUserId"),
      workspaceId,
      z.string().uuid().parse(context.req.param("id")),
    ));
  });
  app.get("/v1/admin/work-threads", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(context.req.query());
    return context.json({
      work_threads: await listWorkThreads(
        db,
        context.get("humanUserId"),
        input.workspace_id,
        input.limit,
      ),
    });
  });
  app.get("/v1/admin/resolution-attempts", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(context.req.query());
    return context.json({
      attempts: await listResolutionAttempts(
        db,
        context.get("humanUserId"),
        input.workspace_id,
        input.limit,
      ),
    });
  });
  app.post("/v1/admin/resolution-attempts/:id/resolve", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
    }).strict().parse(await context.req.json());
    return context.json(await resolveResolutionAttempt(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
    ));
  });
  app.get("/v1/admin/work-threads/:id", async (context) => {
    const workspaceId = z.string().uuid().parse(context.req.query("workspace_id"));
    return context.json(await getWorkThread(
      db,
      context.get("humanUserId"),
      workspaceId,
      context.req.param("id"),
    ));
  });
  app.get("/v1/admin/receipts/:id", async (context) => {
    const workspaceId = z.string().uuid().parse(context.req.query("workspace_id"));
    return context.json(await getReceipt(
      db,
      context.get("humanUserId"),
      workspaceId,
      context.req.param("id"),
    ));
  });
  app.post("/v1/admin/work-threads/:id/preview", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      agent_identity_id: z.string().uuid(),
      token_budget: z.number().int().min(128).max(8_000).default(2_000),
    }).strict().parse(await context.req.json());
    return context.json(await previewContextBriefing(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
      input.agent_identity_id,
      input.token_budget,
    ));
  });
  app.post("/v1/admin/outcomes/:id/confirm", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
    }).strict().parse(await context.req.json());
    return context.json(await confirmOutcome(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
    ));
  });
  app.post("/v1/admin/work-threads/:workId/context-items/:itemId/correct", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      action: z.enum(["edit", "incorrect", "outdated", "delete"]),
      text: z.string().trim().min(1).max(100_000).optional(),
    }).strict().parse(await context.req.json());
    return context.json(await correctContextItem(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("workId"),
      context.req.param("itemId"),
      input,
    ));
  });
  app.post("/v1/admin/work-threads/:workId/context-items/:itemId/restrict", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      agent_identity_ids: z.array(z.string().uuid()).max(100),
    }).strict().parse(await context.req.json());
    return context.json(await restrictContextItem(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("workId"),
      context.req.param("itemId"),
      [...new Set(input.agent_identity_ids)],
    ));
  });
  app.post("/v1/admin/work-threads/:id/merge", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      target_work_thread_id: z.string().uuid(),
    }).strict().parse(await context.req.json());
    return context.json(await mergeWorkThreads(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
      input.target_work_thread_id,
    ));
  });
  app.post("/v1/admin/work-threads/:id/split", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      title: z.string().trim().min(1).max(500),
      objective: z.string().trim().min(1).max(10_000),
      source_event_ids: z.array(z.string().uuid()).min(1).max(1_000),
      idempotency_key: z.string().trim().min(1).max(500),
    }).strict().parse(await context.req.json());
    return context.json(await splitWorkThread(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
      {
        title: input.title,
        objective: input.objective,
        sourceEventIds: [...new Set(input.source_event_ids)],
        idempotencyKey: input.idempotency_key,
      },
    ), 201);
  });
  app.get("/v1/admin/agents", async (context) => {
    const workspaceId = z.string().uuid().parse(context.req.query("workspace_id"));
    return context.json(await listAgents(db, context.get("humanUserId"), workspaceId));
  });
  app.post("/v1/admin/agents", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      name: z.string().trim().min(1).max(500),
      kind: z.enum(["claude-code", "codex", "opencode"]),
    }).strict().parse(await context.req.json());
    return context.json(await createAgentIdentity(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      input,
    ), 201);
  });
  app.get("/v1/admin/connectors", async (context) => {
    const workspaceId = z.string().uuid().parse(context.req.query("workspace_id"));
    return context.json(await listConnectors(db, context.get("humanUserId"), workspaceId));
  });
  app.post("/v1/admin/connectors/:provider/start", async (context) => {
    if (!options.connectorRuntime) {
      return context.json({ error: "Connectors are not configured" }, 503);
    }
    const provider = z.enum(CONNECTOR_PROVIDERS).parse(context.req.param("provider"));
    const input = z.object({
      workspace_id: z.string().uuid(),
      selected_scopes: z.array(z.unknown()).max(1_000).default([]),
    }).strict().parse(await context.req.json());
    return context.json(await startConnectorOAuth(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      provider,
      input.selected_scopes,
      options.publicAppUrl ?? "http://localhost:3000",
      options.connectorRuntime,
    ), 201);
  });
  app.post("/v1/admin/connectors/:id/scopes", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      external_scope_id: z.string().trim().min(1).max(500),
      external_scope_name: z.string().trim().min(1).max(500),
      repository_key: z.string().trim().min(1).max(500),
    }).strict().parse(await context.req.json());
    return context.json(await mapConnectorScope(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
      {
        externalScopeId: input.external_scope_id,
        externalScopeName: input.external_scope_name,
        repositoryKey: input.repository_key,
      },
    ), 201);
  });
  app.post("/v1/admin/connectors/:id/revoke", async (context) => {
    const input = z.object({ workspace_id: z.string().uuid() }).strict()
      .parse(await context.req.json());
    return context.json(await revokeConnector(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
    ));
  });
  app.get("/v1/admin/connector-attention", async (context) => {
    const workspaceId = z.string().uuid().parse(context.req.query("workspace_id"));
    return context.json({
      links: await listConnectorAttention(db, context.get("humanUserId"), workspaceId),
    });
  });
  app.post("/v1/admin/source-links/:id/decide", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      accept: z.boolean(),
    }).strict().parse(await context.req.json());
    return context.json(await decideSourceLink(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
      input.accept,
    ));
  });
  app.post("/v1/admin/agents/:id/status", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      status: z.enum(["active", "disabled"]),
    }).strict().parse(await context.req.json());
    return context.json(await setAgentStatus(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
      input.status,
    ));
  });
  app.post("/v1/admin/credentials", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      agent_identity_id: z.string().uuid(),
      scopes: z.array(z.enum([
        "events:write",
        "context:read",
        "outcomes:write",
      ])).min(1),
      expires_at: z.coerce.date().optional(),
    }).strict().parse(await context.req.json());
    return context.json(await createAgentCredential(
      db,
      pepper,
      context.get("humanUserId"),
      input.workspace_id,
      {
        agentIdentityId: input.agent_identity_id,
        scopes: [...new Set(input.scopes)],
        expiresAt: input.expires_at,
      },
    ), 201);
  });
  app.post("/v1/admin/credentials/:id/rotate", async (context) => {
    const input = z.object({ workspace_id: z.string().uuid() }).strict()
      .parse(await context.req.json());
    return context.json(await rotateAgentCredential(
      db,
      pepper,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
    ), 201);
  });
  app.post("/v1/admin/credentials/:id/revoke", async (context) => {
    const input = z.object({ workspace_id: z.string().uuid() }).strict()
      .parse(await context.req.json());
    return context.json(await revokeAgentCredential(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
    ));
  });
  app.post("/v1/admin/work-threads/:id/grants", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      agent_identity_id: z.string().uuid(),
      can_read_context: z.boolean().default(true),
      can_append_events: z.boolean().default(true),
      can_create_handoff: z.boolean().default(true),
    }).strict().parse(await context.req.json());
    return context.json(await grantWorkThreadAccess(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
      {
        agentIdentityId: input.agent_identity_id,
        canReadContext: input.can_read_context,
        canAppendEvents: input.can_append_events,
        canCreateHandoff: input.can_create_handoff,
      },
    ), 201);
  });
  app.post("/v1/admin/grants/:id/revoke", async (context) => {
    const input = z.object({ workspace_id: z.string().uuid() }).strict()
      .parse(await context.req.json());
    return context.json(await revokeWorkThreadAccess(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
    ));
  });
  app.get("/v1/admin/audit", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(context.req.query());
    return context.json({
      events: await listAuditEvents(
        db,
        context.get("humanUserId"),
        input.workspace_id,
        input.limit,
      ),
    });
  });
  app.post("/v1/admin/context-delivery", async (context) => {
    const input = z.object({
      workspace_id: z.string().uuid(),
      target: z.enum(["workspace", "agent", "work_thread"]),
      target_id: z.string().uuid(),
      enabled: z.boolean(),
    }).strict().parse(await context.req.json());
    return context.json(await setContextDelivery(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      {
        target: input.target,
        targetId: input.target_id,
        enabled: input.enabled,
      },
    ));
  });
  app.post("/v1/admin/devices/:id/revoke", async (context) => {
    const input = z.object({ workspace_id: z.string().uuid() }).strict()
      .parse(await context.req.json());
    return context.json(await revokeDevice(
      db,
      context.get("humanUserId"),
      input.workspace_id,
      context.req.param("id"),
    ));
  });
  app.get("/v1/admin/workspaces/:id/export", async (context) => {
    const exported = await exportWorkspace(
      db,
      context.get("humanUserId"),
      context.req.param("id"),
    );
    context.header(
      "content-disposition",
      `attachment; filename="termyte-${context.req.param("id")}.json"`,
    );
    return context.json(exported);
  });
  app.post("/v1/admin/workspaces/:id/retention", async (context) => {
    const input = z.object({
      retention_days: z.number().int().min(7).max(3_650),
    }).strict().parse(await context.req.json());
    return context.json(await setRetention(
      db,
      context.get("humanUserId"),
      context.req.param("id"),
      input.retention_days,
    ));
  });
  app.delete("/v1/admin/source-events/:id", async (context) => {
    const workspaceId = z.string().uuid().parse(context.req.query("workspace_id"));
    return context.json(await deleteSourceEvent(
      db,
      context.get("humanUserId"),
      workspaceId,
      context.req.param("id"),
    ));
  });
  app.post("/v1/admin/workspaces/:id/delete", async (context) => {
    const input = z.object({
      confirmation_slug: z.string().trim().min(2).max(63),
    }).strict().parse(await context.req.json());
    return context.json(await requestWorkspaceDeletion(
      db,
      context.get("humanUserId"),
      context.req.param("id"),
      input.confirmation_slug,
    ), 202);
  });
  app.post("/v1/events/batch", async (context) => {
    const principal = context.get("principal");
    if (!hasScope(principal, "events:write")) {
      return context.json(protocolError("FORBIDDEN", "Credential lacks events:write", context.get("requestId")), 403);
    }
    let batch;
    let redactedEventIds = new Set<string>();
    try {
      const parsed = parseProtocol(EventBatchRequestSchema, await context.req.json());
      const sanitized = (parsed.events as Array<any>)
        .map((event: any) => redactValue(event, "event") as any);
      redactedEventIds = new Set(sanitized
        .filter((result: any) => result.redaction.applied)
        .map((result: any) => String(result.value.event_id)));
      batch = {
        ...parsed,
        events: sanitized.map((result: any) => result.value),
      };
    } catch {
      return context.json(protocolError("INVALID_ARGUMENT", "Invalid event batch", context.get("requestId")), 400);
    }
    if ((batch.events as any[]).some((event: any) => event.source.platform !== principal.platform)) {
      return context.json(protocolError(
        "INVALID_ARGUMENT",
        "Event source does not match the authenticated Agent Identity",
        context.get("requestId"),
      ), 400);
    }
    const result = await transaction(db, async (client) => {
      const accepted: string[] = [];
      const existing: string[] = [];
      for (const event of batch.events as any[]) {
        if (event.work_thread_id) {
          const grant = await client.query(`
            SELECT can_append_events
            FROM work_thread_agent_grants
            WHERE workspace_id = $1 AND work_thread_id = $2
              AND agent_identity_id = $3 AND revoked_at IS NULL
          `, [principal.workspaceId, event.work_thread_id, principal.agentIdentityId]);
          if (grant.rows[0]?.can_append_events !== true) {
            throw new ForbiddenEventError();
          }
        }
        await client.query(`
          INSERT INTO agent_sessions (
            id, workspace_id, agent_identity_id, credential_id, device_authorization_id,
            source_session_id, source_platform, started_at, last_event_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp($8 / 1000.0))
          ON CONFLICT (workspace_id, agent_identity_id, source_session_id)
          DO UPDATE SET last_event_at = GREATEST(agent_sessions.last_event_at, excluded.last_event_at)
        `, [
          sessionId(principal.agentIdentityId, event.agent_session_id),
          principal.workspaceId,
          principal.agentIdentityId,
          principal.credentialId,
          principal.deviceAuthorizationId,
          event.agent_session_id,
          event.source.platform,
          event.occurred_at,
        ]);
        const internalSessionId = sessionId(principal.agentIdentityId, event.agent_session_id);
        let internalWorkThreadId = (await client.query<{ bound_work_thread_id: string | null }>(`
          SELECT bound_work_thread_id FROM agent_sessions WHERE id = $1
        `, [internalSessionId])).rows[0]?.bound_work_thread_id ?? null;
        if (!internalWorkThreadId && event.repository_key) {
          internalWorkThreadId = (await client.query<{ id: string }>(`
            SELECT id FROM work_threads
            WHERE workspace_id = $1 AND repository_key = $2 AND deleted_at IS NULL
              AND status IN ('proposed','active','blocked','in_review')
            ORDER BY updated_at DESC LIMIT 1
          `, [principal.workspaceId, event.repository_key])).rows[0]?.id ?? null;
        }
        if (!internalWorkThreadId) {
          internalWorkThreadId = randomUUID();
          await client.query(`
            INSERT INTO work_threads (id, workspace_id, title, objective, status, repository_key, idempotency_key, created_by_agent_identity_id)
            VALUES ($1, $2, $3, $4, 'proposed', $5, $6, $7)
          `, [internalWorkThreadId, principal.workspaceId,
            (event.content ?? event.event_type).slice(0, 500),
            (event.content ?? event.event_type).slice(0, 10_000),
            event.repository_key ?? null, `session:${internalSessionId}`, principal.agentIdentityId]);
          await client.query(`
            INSERT INTO work_thread_agent_grants (id, workspace_id, work_thread_id, agent_identity_id, source)
            VALUES ($1, $2, $3, $4, 'contribution') ON CONFLICT DO NOTHING
          `, [randomUUID(), principal.workspaceId, internalWorkThreadId, principal.agentIdentityId]);
        }
        await client.query(`
          UPDATE agent_sessions SET bound_work_thread_id = $1, binding_source = 'resolved', bound_at = COALESCE(bound_at, now())
          WHERE id = $2
        `, [internalWorkThreadId, internalSessionId]);
        const proposedEntityId = randomUUID();
        await client.query(`
          INSERT INTO source_entities (
            id, workspace_id, source, entity_key, work_thread_id
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (workspace_id, source, entity_key) DO NOTHING
        `, [
          proposedEntityId,
          principal.workspaceId,
          event.source.platform,
          event.event_id,
          internalWorkThreadId,
        ]);
        const sourceEntityId = (await client.query<{ id: string }>(`
          SELECT id FROM source_entities
          WHERE workspace_id = $1 AND source = $2 AND entity_key = $3
        `, [principal.workspaceId, event.source.platform, event.event_id])).rows[0]!.id;
        const inserted = await client.query<{ id: string }>(`
          INSERT INTO source_events (
            id, workspace_id, work_thread_id, agent_identity_id, agent_session_id,
            source, external_id, event_type, occurred_at, received_at,
            schema_version, payload_json, payload_text, redaction_state,
            source_entity_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            to_timestamp($9 / 1000.0), now(), $10, $11, $12, $13, $14
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        `, [
          randomUUID(),
          principal.workspaceId,
          internalWorkThreadId,
          principal.agentIdentityId,
          sessionId(principal.agentIdentityId, event.agent_session_id),
          event.source.platform,
          event.event_id,
          event.event_type,
          event.occurred_at,
          batch.schema_version,
          event,
          event.content ?? null,
          redactedEventIds.has(event.event_id) ? "server" : "edge",
          sourceEntityId,
        ]);
        if (inserted.rows[0]) {
          await client.query(`
            UPDATE source_entities
            SET current_source_event_id = $1, updated_at = now()
            WHERE id = $2
          `, [inserted.rows[0].id, sourceEntityId]);
        }
        if (inserted.rows[0]) {
          await client.query(`
            INSERT INTO jobs (
              id, workspace_id, kind, dedupe_key, payload_json, state
            ) VALUES ($1, $2, 'project_event', $3, $4, 'pending')
            ON CONFLICT (kind, dedupe_key) DO NOTHING
          `, [
            randomUUID(),
            principal.workspaceId,
            inserted.rows[0].id,
            { source_event_id: inserted.rows[0].id },
          ]);
        }
        (inserted.rowCount === 1 ? accepted : existing).push(event.event_id);
      }
      return { accepted, existing };
    });
    return context.json({
      schema_version: TERMYTE_PROTOCOL_VERSION,
      accepted_event_ids: result.accepted,
      existing_event_ids: result.existing,
    });
  });
  app.post("/v1/context/resolve", async (context) => {
    const principal = context.get("principal");
    if (!hasScope(principal, "context:read")) {
      return context.json(protocolError("FORBIDDEN", "Credential lacks context:read", context.get("requestId")), 403);
    }
    try {
      const input = parseProtocol(ResolveContextRequestSchema, await context.req.json());
      const internal = {
        ...input,
        token_budget: input.cloud_token_budget,
        recent_work_thread_ids: undefined,
      } as any;
      const result = await resolveContext(db, principal, internal, options.contextLLM);
      if (result.state === "not_found" || result.state === "clarification_required") {
        return context.json({
          schema_version: 3,
          state: "abstained",
          receipt_id: result.receipt_id ?? "",
          code: result.state === "clarification_required" ? "low_confidence" : "no_match",
          message: result.message ?? "No sufficiently confident context match.",
        });
      }
      if (result.state !== "resolved") return context.json(result);
      return context.json({
        schema_version: 3,
        state: "context",
        receipt_id: result.receipt_id,
        task_mode: result.task_mode,
        items: (result.sources ?? []).map((item: any) => ({
          item_id: item.context_item_id,
          type: item.type === "objective" || item.type === "current_state" || item.type === "observation" ? "fact" : item.type,
          text: item.text ?? item.inclusion_reason,
          status: "observed",
          confidence: item.confidence ?? 1,
          task_relevance: 100,
          company_relevance: 50,
          task_reason: item.inclusion_reason,
          company_reason: "Related to the resolved repository task",
          source: { source_record_id: item.source_event_ids?.[0] ?? item.context_item_id, provider: "agent", title: item.type, occurred_at: Date.now() },
        })),
        omitted_count: 0,
        expires_at: result.expires_at,
      });
    } catch (error) {
      if (error instanceof SyntaxError || isValidationError(error)) {
        return context.json(protocolError("INVALID_ARGUMENT", "Invalid context request", context.get("requestId")), 400);
      }
      throw error;
    }
  });
  app.post("/v1/receipts/:id/ack", async (context) => {
    const principal = context.get("principal");
    if (!hasScope(principal, "context:read")) {
      return context.json(protocolError("FORBIDDEN", "Credential lacks context:read", context.get("requestId")), 403);
    }
    try {
      const body = await context.req.json() as Record<string, unknown>;
      const normalizedBody = body.delivery_status
        ? body
        : body.failure_code !== undefined
          ? { ...body, delivery_status: "failed" as const }
          : body.delivered_at !== undefined
            ? { ...body, delivery_status: "delivered" as const }
            : body;
      const input = parseProtocol(AcknowledgeReceiptRequestSchema, normalizedBody);
      return context.json(await acknowledgeReceipt(db, principal, context.req.param("id"), input));
    } catch (error) {
      if (error instanceof SyntaxError || isValidationError(error)) {
        return context.json(protocolError("INVALID_ARGUMENT", "Invalid receipt acknowledgement", context.get("requestId")), 400);
      }
      throw error;
    }
  });
  app.post("/v1/outcomes", async (context) => {
    const principal = context.get("principal");
    if (!hasScope(principal, "outcomes:write")) {
      return context.json(protocolError("FORBIDDEN", "Credential lacks outcomes:write", context.get("requestId")), 403);
    }
    try {
      const input = parseProtocol(ReportOutcomeRequestSchema, await context.req.json());
      return context.json(await reportOutcome(db, principal, input), 201);
    } catch (error) {
      if (error instanceof SyntaxError || isValidationError(error)) {
        return context.json(protocolError("INVALID_ARGUMENT", "Invalid outcome", context.get("requestId")), 400);
      }
      throw error;
    }
  });
  app.onError((error, context) => {
    if (error instanceof HTTPException) return error.getResponse();
    const forbidden = error instanceof ForbiddenEventError || error instanceof ForbiddenError;
    const notFound = error instanceof NotFoundError;
    const conflict = error instanceof ConflictError;
    const invalid = error instanceof SyntaxError || isValidationError(error);
    const code = invalid ? "INVALID_ARGUMENT"
      : forbidden ? "FORBIDDEN"
        : notFound ? "NOT_FOUND"
          : conflict ? "CONFLICT"
            : "INTERNAL";
    const status = invalid ? 400 : forbidden ? 403 : notFound ? 404 : conflict ? 409 : 500;
    if (status === 500) {
      process.stderr.write(`${JSON.stringify({
        level: "error",
        request_id: context.get("requestId"),
        message: error instanceof Error ? error.message : String(error),
      })}\n`);
    }
    return context.json(protocolError(
      code,
      invalid ? "Invalid request"
        : forbidden ? "Not permitted"
        : notFound ? "Resource not found"
          : conflict ? error.message
            : "Internal server error",
      context.get("requestId"),
      status === 500,
    ), status);
  });
  return app;
}

function protocolError(
  code: "INVALID_ARGUMENT" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "INTERNAL",
  message: string,
  requestId: string,
  retryable = false,
) {
  return {
    schema_version: TERMYTE_PROTOCOL_VERSION,
    code,
    message,
    request_id: requestId,
    retryable,
  };
}

function clientAddress(context: { req: { header(name: string): string | undefined } }): string {
  return context.req.header("cf-connecting-ip")
    ?? context.req.header("x-real-ip")
    ?? context.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
}

class ForbiddenEventError extends Error {}

function isValidationError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "ZodError" || error.name === "UnsupportedProtocolVersionError");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const db = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const authenticateHuman = config.SUPABASE_URL && config.SUPABASE_ANON_KEY
    ? createSupabaseHumanAuthenticator(config.SUPABASE_URL, config.SUPABASE_ANON_KEY)
    : undefined;
  const connectorRuntime: ConnectorRuntime | undefined = config.CONNECTOR_ENCRYPTION_KEY
    ? {
        encryptionKey: connectorKey(config.CONNECTOR_ENCRYPTION_KEY),
        github: config.GITHUB_APP_SLUG ? { appSlug: config.GITHUB_APP_SLUG } : undefined,
        slack: config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET
          ? { clientId: config.SLACK_CLIENT_ID, clientSecret: config.SLACK_CLIENT_SECRET }
          : undefined,
        webhookSecrets: {
          github: config.GITHUB_WEBHOOK_SECRET,
          slack: config.SLACK_SIGNING_SECRET,
        },
      }
    : undefined;
  const server = serve({
    fetch: createApp(db, config.AGENT_TOKEN_PEPPER, {
      authenticateHuman,
      demoUserId: config.DEMO_USER_ID,
      webAuth: config.SUPABASE_URL && config.SUPABASE_ANON_KEY
        ? { supabaseUrl: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY }
        : undefined,
      publicAppUrl: config.PUBLIC_APP_URL,
      connectorRuntime,
      contextLLM: config.OPENROUTER_API_KEY ? {
        baseUrl: config.OPENROUTER_BASE_URL,
        apiKey: config.OPENROUTER_API_KEY,
        model: config.OPENROUTER_MODEL,
        timeoutMs: config.OPENROUTER_TIMEOUT_MS,
      } : undefined,
    }).fetch,
    port: config.PORT,
  });
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`${JSON.stringify({ level: "info", message: "shutting down", signal })}\n`);
    server.close(async () => {
      await db.end();
      process.exitCode = 0;
    });
    setTimeout(() => {
      process.stderr.write(`${JSON.stringify({ level: "error", message: "forced shutdown" })}\n`);
      process.exit(1);
    }, 25_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

function matchesBearer(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
