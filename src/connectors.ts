import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type pg from "pg";
import { redactValue } from "termyte/security/redaction";
import type { Database } from "./db.js";
import { transaction } from "./db.js";
import { ForbiddenError, NotFoundError } from "./work.js";

export const CONNECTOR_PROVIDERS = ["github", "slack", "linear"] as const;
export type ConnectorProvider = typeof CONNECTOR_PROVIDERS[number];

export interface ConnectorRuntime {
  encryptionKey: Buffer;
  github?: { appSlug: string };
  slack?: { clientId: string; clientSecret: string };
  linear?: { clientId: string; clientSecret: string };
  webhookSecrets: Partial<Record<ConnectorProvider, string>>;
  fetch?: typeof fetch;
}

export interface NormalizedConnectorEvent {
  provider: ConnectorProvider;
  externalAccountId: string;
  externalId: string;
  eventType: "observation" | "decision" | "constraint" | "failure" | "evidence" | "outcome";
  title: string;
  text: string;
  canonicalUrl?: string;
  externalScopeId?: string;
  repositoryKey?: string;
  occurredAt: Date;
  providerUpdatedAt?: Date;
  raw: Record<string, unknown>;
}

export function connectorKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error("CONNECTOR_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return decoded;
}

export function encryptCredentials(
  key: Buffer,
  credentials: Record<string, unknown>,
): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptCredentials(
  key: Buffer,
  encrypted: Buffer,
): Record<string, unknown> {
  if (encrypted.length < 29) throw new Error("Invalid encrypted connector credentials");
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
  decipher.setAuthTag(encrypted.subarray(12, 28));
  return JSON.parse(Buffer.concat([
    decipher.update(encrypted.subarray(28)),
    decipher.final(),
  ]).toString("utf8")) as Record<string, unknown>;
}

export function verifyConnectorWebhook(
  provider: ConnectorProvider,
  rawBody: string,
  headers: Headers,
  secret: string,
  now = Date.now(),
): boolean {
  if (provider === "github") {
    return matchesMac(
      headers.get("x-hub-signature-256"),
      `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
    );
  }
  if (provider === "slack") {
    const timestamp = headers.get("x-slack-request-timestamp");
    if (!timestamp || Math.abs(now / 1_000 - Number(timestamp)) > 300) return false;
    return matchesMac(
      headers.get("x-slack-signature"),
      `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`,
    );
  }
  const timestamp = headers.get("webhook-timestamp");
  if (!timestamp || Math.abs(now - Number(timestamp)) > 60_000) return false;
  return matchesMac(
    headers.get("linear-signature"),
    createHmac("sha256", secret).update(rawBody).digest("hex"),
  );
}

function matchesMac(received: string | null, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function startConnectorOAuth(
  db: Database,
  userId: string,
  workspaceId: string,
  provider: ConnectorProvider,
  selectedScopes: unknown[],
  publicAppUrl: string,
  runtime: ConnectorRuntime,
) {
  await requireAdmin(db, userId, workspaceId);
  const state = randomBytes(32).toString("base64url");
  await db.query(`
    INSERT INTO connector_oauth_states (
      state_hash, workspace_id, provider, user_id, selected_scopes, expires_at
    ) VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')
  `, [stateHash(state), workspaceId, provider, userId, selectedScopes]);
  const callbackUrl = new URL("/v1/connectors/oauth/callback", publicAppUrl);
  callbackUrl.searchParams.set("provider", provider);
  const callback = callbackUrl.toString();
  let authorizationUrl: URL;
  if (provider === "github") {
    if (!runtime.github) throw new Error("GitHub App is not configured");
    authorizationUrl = new URL(`https://github.com/apps/${runtime.github.appSlug}/installations/new`);
    authorizationUrl.searchParams.set("state", state);
  } else if (provider === "slack") {
    if (!runtime.slack) throw new Error("Slack OAuth is not configured");
    authorizationUrl = new URL("https://slack.com/oauth/v2/authorize");
    authorizationUrl.searchParams.set("client_id", runtime.slack.clientId);
    authorizationUrl.searchParams.set(
      "scope",
      "channels:history,channels:read,groups:history,groups:read",
    );
    authorizationUrl.searchParams.set("redirect_uri", callback);
    authorizationUrl.searchParams.set("state", state);
  } else {
    if (!runtime.linear) throw new Error("Linear OAuth is not configured");
    authorizationUrl = new URL("https://linear.app/oauth/authorize");
    authorizationUrl.searchParams.set("client_id", runtime.linear.clientId);
    authorizationUrl.searchParams.set("redirect_uri", callback);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", "read");
    authorizationUrl.searchParams.set("state", state);
  }
  return { authorization_url: authorizationUrl.toString() };
}

export async function finishConnectorOAuth(
  db: Database,
  provider: ConnectorProvider,
  input: { state: string; code?: string; installationId?: string },
  publicAppUrl: string,
  runtime: ConnectorRuntime,
) {
  const pending = (await db.query<{
    workspace_id: string;
    user_id: string;
    selected_scopes: unknown[];
  }>(`
    SELECT workspace_id, user_id, selected_scopes
    FROM connector_oauth_states
    WHERE state_hash = $1 AND provider = $2 AND used_at IS NULL AND expires_at > now()
  `, [stateHash(input.state), provider])).rows[0];
  if (!pending) throw new ForbiddenError("Invalid or expired connector authorization");
  const exchanged = await exchangeProvider(provider, input, publicAppUrl, runtime);
  return transaction(db, async (client) => {
    const claimed = await client.query(`
      UPDATE connector_oauth_states
      SET used_at = now()
      WHERE state_hash = $1 AND provider = $2 AND used_at IS NULL AND expires_at > now()
    `, [stateHash(input.state), provider]);
    if (claimed.rowCount !== 1) {
      throw new ForbiddenError("Connector authorization was already used");
    }
    const id = randomUUID();
    const row = (await client.query(`
      INSERT INTO connector_connections (
        id, workspace_id, provider, name, external_account_id,
        credentials_ciphertext, selected_scopes, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (workspace_id, provider, external_account_id)
      DO UPDATE SET
        name = excluded.name,
        credentials_ciphertext = excluded.credentials_ciphertext,
        selected_scopes = excluded.selected_scopes,
        status = 'active',
        last_error = NULL,
        revoked_at = NULL,
        updated_at = now()
      RETURNING id, workspace_id, provider, name, external_account_id, status
    `, [
      id,
      pending.workspace_id,
      provider,
      exchanged.name,
      exchanged.externalAccountId,
      encryptCredentials(runtime.encryptionKey, exchanged.credentials),
      pending.selected_scopes,
      pending.user_id,
    ])).rows[0];
    await audit(client, pending.workspace_id, pending.user_id, "connector.connect", "connector", row.id, {
      provider,
      external_account_id: exchanged.externalAccountId,
    });
    return row;
  });
}

async function exchangeProvider(
  provider: ConnectorProvider,
  input: { code?: string; installationId?: string },
  publicAppUrl: string,
  runtime: ConnectorRuntime,
) {
  if (provider === "github") {
    if (!input.installationId) throw new Error("GitHub installation_id is required");
    return {
      externalAccountId: input.installationId,
      name: `GitHub installation ${input.installationId}`,
      credentials: { installation_id: input.installationId },
    };
  }
  if (!input.code) throw new Error("OAuth code is required");
  const request = runtime.fetch ?? fetch;
  const callbackUrl = new URL("/v1/connectors/oauth/callback", publicAppUrl);
  callbackUrl.searchParams.set("provider", provider);
  const callback = callbackUrl.toString();
  if (provider === "slack") {
    if (!runtime.slack) throw new Error("Slack OAuth is not configured");
    const response = await request("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: runtime.slack.clientId,
        client_secret: runtime.slack.clientSecret,
        code: input.code,
        redirect_uri: callback,
      }),
    });
    const value = await response.json() as {
      ok?: boolean;
      error?: string;
      access_token?: string;
      team?: { id?: string; name?: string };
    };
    if (!response.ok || !value.ok || !value.access_token || !value.team?.id) {
      throw new Error(`Slack OAuth failed: ${value.error ?? response.status}`);
    }
    return {
      externalAccountId: value.team.id,
      name: value.team.name ?? `Slack ${value.team.id}`,
      credentials: { access_token: value.access_token },
    };
  }
  if (!runtime.linear) throw new Error("Linear OAuth is not configured");
  const response = await request("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: runtime.linear.clientId,
      client_secret: runtime.linear.clientSecret,
      code: input.code,
      redirect_uri: callback,
      grant_type: "authorization_code",
    }),
  });
  const token = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!response.ok || !token.access_token) throw new Error(`Linear OAuth failed: ${response.status}`);
  const organization = await request("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "{ organization { id name } }" }),
  });
  const organizationValue = await organization.json() as {
    data?: { organization?: { id?: string; name?: string } };
  };
  const org = organizationValue.data?.organization;
  if (!organization.ok || !org?.id) throw new Error("Linear organization lookup failed");
  return {
    externalAccountId: org.id,
    name: org.name ?? `Linear ${org.id}`,
    credentials: {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_in: token.expires_in,
    },
  };
}

export async function listConnectors(db: Database, userId: string, workspaceId: string) {
  await requireMember(db, userId, workspaceId);
  const [connections, mappings] = await Promise.all([
    db.query(`
      SELECT id, provider, name, external_account_id, selected_scopes, status,
        last_synced_at, last_error, created_at, revoked_at
      FROM connector_connections
      WHERE workspace_id = $1 ORDER BY provider, created_at
    `, [workspaceId]),
    db.query(`
      SELECT id, connector_connection_id, external_scope_id, external_scope_name,
        repository_key, created_at
      FROM connector_scope_mappings
      WHERE workspace_id = $1 ORDER BY external_scope_name
    `, [workspaceId]),
  ]);
  return { connections: connections.rows, mappings: mappings.rows };
}

export async function mapConnectorScope(
  db: Database,
  userId: string,
  workspaceId: string,
  connectorId: string,
  input: { externalScopeId: string; externalScopeName: string; repositoryKey: string },
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const connection = await client.query(`
      SELECT 1 FROM connector_connections
      WHERE id = $1 AND workspace_id = $2 AND status <> 'revoked'
    `, [connectorId, workspaceId]);
    if (!connection.rows[0]) throw new NotFoundError();
    const id = randomUUID();
    const row = (await client.query(`
      INSERT INTO connector_scope_mappings (
        id, workspace_id, connector_connection_id, external_scope_id,
        external_scope_name, repository_key, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (connector_connection_id, external_scope_id)
      DO UPDATE SET external_scope_name = excluded.external_scope_name,
        repository_key = excluded.repository_key
      RETURNING *
    `, [
      id,
      workspaceId,
      connectorId,
      input.externalScopeId,
      input.externalScopeName,
      input.repositoryKey,
      userId,
    ])).rows[0];
    await audit(client, workspaceId, userId, "connector.scope.map", "connector", connectorId, {
      external_scope_id: input.externalScopeId,
      repository_key: input.repositoryKey,
    });
    return row;
  });
}

export async function revokeConnector(
  db: Database,
  userId: string,
  workspaceId: string,
  connectorId: string,
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const result = await client.query(`
      UPDATE connector_connections
      SET status = 'revoked', revoked_at = now(), credentials_ciphertext = NULL,
        updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status <> 'revoked'
    `, [connectorId, workspaceId]);
    if (result.rowCount !== 1) throw new NotFoundError();
    await audit(client, workspaceId, userId, "connector.revoke", "connector", connectorId);
    return { revoked: true };
  });
}

export async function ingestConnectorWebhook(
  db: Database,
  event: NormalizedConnectorEvent,
) {
  return transaction(db, async (client) => {
    const connection = (await client.query<{
      id: string;
      workspace_id: string;
    }>(`
      SELECT id, workspace_id FROM connector_connections
      WHERE provider = $1 AND external_account_id = $2 AND status = 'active'
      FOR UPDATE
    `, [event.provider, event.externalAccountId])).rows[0];
    if (!connection) throw new NotFoundError("Connector connection not found");
    const mappedRepository = event.externalScopeId
      ? (await client.query<{ repository_key: string }>(`
          SELECT repository_key FROM connector_scope_mappings
          WHERE connector_connection_id = $1 AND external_scope_id = $2
        `, [connection.id, event.externalScopeId])).rows[0]?.repository_key
      : undefined;
    if ((event.provider === "slack" || event.provider === "linear") && !mappedRepository) {
      return { accepted: false, duplicate: false, ignored: "scope_not_selected" };
    }
    const scopedEvent = {
      ...event,
      repositoryKey: event.repositoryKey ?? mappedRepository,
    };
    const redacted = redactValue({
      title: scopedEvent.title,
      text: scopedEvent.text,
      raw: scopedEvent.raw,
    }, "connector_event");
    const contentHash = createHash("sha256")
      .update(`${event.title}\0${event.text}`)
      .digest("hex");
    const sourceId = randomUUID();
    const inserted = (await client.query<{ id: string }>(`
      INSERT INTO source_events (
        id, workspace_id, connector_connection_id, source, external_id,
        event_type, occurred_at, schema_version, payload_json, payload_text,
        redaction_state, content_hash, canonical_url, provider_updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (workspace_id, source, external_id)
      DO UPDATE SET
        payload_json = excluded.payload_json,
        payload_text = excluded.payload_text,
        redaction_state = excluded.redaction_state,
        content_hash = excluded.content_hash,
        canonical_url = excluded.canonical_url,
        provider_updated_at = excluded.provider_updated_at,
        received_at = now()
      WHERE source_events.content_hash IS DISTINCT FROM excluded.content_hash
      RETURNING id
    `, [
      sourceId,
      connection.workspace_id,
      connection.id,
      event.provider,
      event.externalId,
      event.eventType,
      event.occurredAt,
      {
        title: redacted.value.title,
        text: redacted.value.text,
        raw: redacted.value.raw,
        external_scope_id: scopedEvent.externalScopeId,
        repository_key: scopedEvent.repositoryKey,
      },
      redacted.value.text,
      redacted.redaction.applied ? "server" : "connector",
      contentHash,
      event.canonicalUrl ?? null,
      event.providerUpdatedAt ?? null,
    ])).rows[0];
    if (!inserted) return { accepted: false, duplicate: true };
    const link = await linkConnectorEvent(client, connection, inserted.id, scopedEvent);
    await client.query(`
      UPDATE connector_connections SET last_synced_at = now(), last_error = NULL, updated_at = now()
      WHERE id = $1
    `, [connection.id]);
    return { accepted: true, duplicate: false, source_event_id: inserted.id, link };
  });
}

async function linkConnectorEvent(
  client: pg.PoolClient,
  connection: { id: string; workspace_id: string },
  sourceEventId: string,
  event: NormalizedConnectorEvent,
) {
  const mapped = event.repositoryKey ?? (event.externalScopeId
    ? (await client.query<{ repository_key: string }>(`
        SELECT repository_key FROM connector_scope_mappings
        WHERE connector_connection_id = $1 AND external_scope_id = $2
      `, [connection.id, event.externalScopeId])).rows[0]?.repository_key
    : undefined);
  const candidate = (await client.query<{
    id: string;
    repository_key: string | null;
    score: number;
  }>(`
    SELECT id, repository_key,
      GREATEST(
        similarity(title, $3),
        ts_rank(
          to_tsvector('english', coalesce(title, '') || ' ' || coalesce(objective, '') || ' ' || coalesce(current_summary, '')),
          plainto_tsquery('english', $4)
        )
      )::float8 AS score
    FROM work_threads
    WHERE workspace_id = $1 AND deleted_at IS NULL
      AND status IN ('proposed', 'active', 'blocked', 'in_review')
      AND ($2::text IS NULL OR repository_key = $2)
    ORDER BY score DESC, updated_at DESC
    LIMIT 1
  `, [connection.workspace_id, mapped ?? null, event.title, `${event.title} ${event.text}`])).rows[0];

  let workThreadId = candidate?.id;
  let state: "automatic" | "proposed" = "automatic";
  let confidence = Math.min(0.99, Math.max(0.6, candidate?.score ?? 0));
  let reason = mapped ? "repository mapping and matching work" : "matching work";

  if (!candidate || candidate.score < 0.08) {
    workThreadId = randomUUID();
    await client.query(`
      INSERT INTO work_threads (
        id, workspace_id, title, objective, status, current_summary,
        repository_key, idempotency_key
      ) VALUES ($1, $2, $3, $4, 'proposed', $5, $6, $7)
    `, [
      workThreadId,
      connection.workspace_id,
      event.title.slice(0, 500),
      event.text.slice(0, 10_000),
      `Created from ${event.provider} organizational context`,
      mapped ?? null,
      `connector:${event.provider}:${event.externalId}`,
    ]);
    await client.query(`
      INSERT INTO work_thread_agent_grants (
        id, workspace_id, work_thread_id, agent_identity_id, source
      )
      SELECT gen_random_uuid(), $1, $2, id, 'human'
      FROM agent_identities
      WHERE workspace_id = $1 AND status = 'active'
        AND kind IN ('claude-code', 'codex', 'opencode')
    `, [connection.workspace_id, workThreadId]);
    confidence = mapped ? 0.9 : 0.65;
    reason = mapped ? "new work in an administrator-mapped repository" : "new organizational work";
  }

  const crossRepository = Boolean(
    mapped && candidate?.repository_key && candidate.repository_key !== mapped,
  );
  if (crossRepository) state = "proposed";
  await client.query(`
    UPDATE source_events
    SET work_thread_id = CASE WHEN $3 = 'automatic' THEN $1::uuid ELSE NULL END
    WHERE id = $2
  `, [workThreadId, sourceEventId, state]);
  const linkId = randomUUID();
  await client.query(`
    INSERT INTO source_event_links (
      id, workspace_id, source_event_id, work_thread_id, reason,
      confidence, state, cross_repository, evidence_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (source_event_id, work_thread_id)
    DO UPDATE SET reason = excluded.reason, confidence = excluded.confidence,
      evidence_json = excluded.evidence_json
  `, [
    linkId,
    connection.workspace_id,
    sourceEventId,
    workThreadId,
    reason,
    confidence,
    state,
    crossRepository,
    { repository_key: mapped ?? null, provider: event.provider },
  ]);
  if (state === "automatic") {
    await enqueueProjection(client, connection.workspace_id, sourceEventId);
  }
  return { id: linkId, work_thread_id: workThreadId, state, confidence };
}

export async function listConnectorAttention(
  db: Database,
  userId: string,
  workspaceId: string,
) {
  await requireMember(db, userId, workspaceId);
  return (await db.query(`
    SELECT l.id, l.source_event_id, l.work_thread_id, l.reason, l.confidence,
      l.cross_repository, l.evidence_json, l.created_at,
      se.source AS provider, se.payload_text, se.canonical_url,
      w.title AS work_thread_title, w.repository_key
    FROM source_event_links l
    JOIN source_events se ON se.id = l.source_event_id
    JOIN work_threads w ON w.id = l.work_thread_id
    WHERE l.workspace_id = $1 AND l.state = 'proposed'
    ORDER BY l.created_at DESC
  `, [workspaceId])).rows;
}

export async function decideSourceLink(
  db: Database,
  userId: string,
  workspaceId: string,
  linkId: string,
  accept: boolean,
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const link = (await client.query<{
      source_event_id: string;
      work_thread_id: string;
    }>(`
      UPDATE source_event_links
      SET state = $1, confirmed_by_user_id = $2, confirmed_at = now()
      WHERE id = $3 AND workspace_id = $4 AND state = 'proposed'
      RETURNING source_event_id, work_thread_id
    `, [accept ? "confirmed" : "rejected", userId, linkId, workspaceId])).rows[0];
    if (!link) throw new NotFoundError();
    if (accept) {
      await client.query(`UPDATE source_events SET work_thread_id = $1 WHERE id = $2`, [
        link.work_thread_id,
        link.source_event_id,
      ]);
      await enqueueProjection(client, workspaceId, link.source_event_id);
    }
    await audit(
      client,
      workspaceId,
      userId,
      accept ? "source_link.confirm" : "source_link.reject",
      "source_event_link",
      linkId,
    );
    return { state: accept ? "confirmed" : "rejected" };
  });
}

async function enqueueProjection(
  client: pg.PoolClient,
  workspaceId: string,
  sourceEventId: string,
) {
  await client.query(`
    INSERT INTO jobs (id, workspace_id, kind, dedupe_key, payload_json, state)
    VALUES ($1, $2, 'project_event', $3, $4, 'pending')
    ON CONFLICT (kind, dedupe_key) DO UPDATE
      SET state = CASE WHEN jobs.state = 'succeeded' THEN 'pending' ELSE jobs.state END,
        next_run_at = now(), updated_at = now()
  `, [randomUUID(), workspaceId, sourceEventId, { source_event_id: sourceEventId }]);
}

export function normalizeConnectorWebhook(
  provider: ConnectorProvider,
  body: Record<string, any>,
  headers: Headers,
): NormalizedConnectorEvent | null {
  if (provider === "github") {
    const item = body.comment ?? body.review ?? body.issue ?? body.pull_request ?? body.discussion;
    const repository = body.repository;
    const account = body.installation?.id;
    if (!item?.id || !repository?.full_name || !account) return null;
    const action = typeof body.action === "string" ? body.action : "updated";
    const title = item.title ?? body.issue?.title ?? body.pull_request?.title
      ?? `GitHub ${headers.get("x-github-event") ?? "event"}`;
    return {
      provider,
      externalAccountId: String(account),
      externalId: `${headers.get("x-github-event") ?? "event"}:${item.id}`,
      eventType: headers.get("x-github-event")?.includes("review") ? "evidence" : "observation",
      title: String(title),
      text: `${action}: ${String(item.body ?? item.state ?? title)}`,
      canonicalUrl: item.html_url,
      externalScopeId: String(repository.id),
      repositoryKey: `github.com/${repository.full_name}`,
      occurredAt: date(item.created_at ?? body.repository?.updated_at),
      providerUpdatedAt: date(item.updated_at ?? item.submitted_at),
      raw: body,
    };
  }
  if (provider === "slack") {
    if (body.type !== "event_callback" || body.event?.type !== "message") return null;
    const event = body.event;
    if (event.bot_id || event.subtype) return null;
    if (!body.team_id || !event.channel || !event.ts || !event.text) return null;
    const title = String(event.text).split(/\r?\n/, 1)[0]!.trim().slice(0, 120);
    return {
      provider,
      externalAccountId: String(body.team_id),
      externalId: `${event.channel}:${event.ts}`,
      eventType: "observation",
      title,
      text: String(event.text),
      externalScopeId: String(event.channel),
      occurredAt: new Date(Number(event.ts) * 1_000),
      providerUpdatedAt: event.edited?.ts ? new Date(Number(event.edited.ts) * 1_000) : undefined,
      raw: body,
    };
  }
  const data = body.data;
  const organizationId = body.organizationId ?? body.organization?.id;
  if (!organizationId || !data?.id) return null;
  const type = String(body.type ?? "Linear");
  const title = String(data.title ?? data.body?.slice?.(0, 120) ?? `${type} update`);
  return {
    provider,
    externalAccountId: String(organizationId),
    externalId: `${type}:${data.id}`,
    eventType: type === "Comment" ? "observation" : "decision",
    title,
    text: String(data.description ?? data.body ?? `${body.action ?? "updated"} ${title}`),
    canonicalUrl: data.url,
    externalScopeId: String(data.teamId ?? data.projectId ?? data.team?.id ?? ""),
    occurredAt: date(data.createdAt ?? body.webhookTimestamp),
    providerUpdatedAt: date(data.updatedAt ?? body.webhookTimestamp),
    raw: body,
  };
}

function date(value: unknown): Date {
  const parsed = new Date(typeof value === "number" ? value : String(value ?? Date.now()));
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function stateHash(state: string): Buffer {
  return createHash("sha256").update(state).digest();
}

async function requireMember(
  db: Pick<Database, "query"> | pg.PoolClient,
  userId: string,
  workspaceId: string,
) {
  const row = (await db.query<{ role: string }>(`
    SELECT role FROM workspace_memberships
    WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL
  `, [workspaceId, userId])).rows[0];
  if (!row) throw new ForbiddenError();
  return row;
}

async function requireAdmin(
  db: Pick<Database, "query"> | pg.PoolClient,
  userId: string,
  workspaceId: string,
) {
  const member = await requireMember(db, userId, workspaceId);
  if (member.role === "member") throw new ForbiddenError();
}

async function audit(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
) {
  await client.query(`
    INSERT INTO audit_events (
      id, workspace_id, actor_type, actor_id, action,
      target_type, target_id, metadata_json
    ) VALUES ($1, $2, 'human', $3, $4, $5, $6, $7)
  `, [randomUUID(), workspaceId, userId, action, targetType, targetId, metadata]);
}
