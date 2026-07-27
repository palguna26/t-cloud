import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentPlatform, AgentScope } from "termyte/protocol";
import type { Database } from "./db.js";

export interface IssuedAgentCredential {
  token: string;
  prefix: string;
  secretHash: Buffer;
}

export interface AgentPrincipal {
  workspaceId: string;
  agentIdentityId: string;
  credentialId: string | null;
  deviceAuthorizationId: string | null;
  scopes: AgentScope[];
  platform: AgentPlatform;
  contextDeliveryEnabled: boolean;
}

const lastSeenStamps = new Map<string, number>();

export function issueAgentCredential(pepper: string): IssuedAgentCredential {
  const prefix = randomBytes(9).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return {
    token: `tyt_live_${prefix}_${secret}`,
    prefix,
    secretHash: hashAgentSecret(secret, pepper),
  };
}

export function hashAgentSecret(secret: string, pepper: string): Buffer {
  return createHash("sha256").update(secret).update(pepper).digest();
}

export function parseAgentCredential(token: string): { prefix: string; secret: string } | null {
  const match = /^tyt_live_([a-f0-9]{18})_([A-Za-z0-9_-]{43})$/.exec(token);
  return match ? { prefix: match[1]!, secret: match[2]! } : null;
}

export async function authenticateAgent(
  db: Database,
  token: string,
  pepper: string,
): Promise<AgentPrincipal | null> {
  const parsed = parseAgentCredential(token);
  if (!parsed) return null;
  const result = await db.query<{
    id: string;
    workspace_id: string;
    agent_identity_id: string;
    secret_hash: Buffer;
    scopes: AgentScope[];
    kind: AgentPlatform;
    auth_kind: "credential" | "device";
    context_delivery_enabled: boolean;
  }>(`
    SELECT auth.*, a.kind, true AS context_delivery_enabled
    FROM (
      SELECT c.id, c.workspace_id, c.agent_identity_id, c.secret_hash, c.scopes,
        'credential'::text AS auth_kind
      FROM agent_credentials c
      WHERE c.token_prefix = $1
        AND c.revoked_at IS NULL
        AND (c.expires_at IS NULL OR c.expires_at > now())
      UNION ALL
      SELECT d.id, d.workspace_id, d.agent_identity_id, d.secret_hash, d.scopes,
        'device'::text AS auth_kind
      FROM device_authorizations d
      WHERE d.token_prefix = $1
        AND d.revoked_at IS NULL
        AND (d.expires_at IS NULL OR d.expires_at > now())
    ) auth
    JOIN agent_identities a
      ON a.id = auth.agent_identity_id AND a.workspace_id = auth.workspace_id
    JOIN workspaces w ON w.id = auth.workspace_id
    WHERE a.status = 'active'
    LIMIT 1
  `, [parsed.prefix]);
  const row = result.rows[0];
  if (!row) return null;
  const actual = hashAgentSecret(parsed.secret, pepper);
  if (row.secret_hash.length !== actual.length || !timingSafeEqual(row.secret_hash, actual)) {
    return null;
  }
  const now = Date.now();
  if ((lastSeenStamps.get(row.id) ?? 0) < now - 5 * 60_000) {
    lastSeenStamps.set(row.id, now);
    if (lastSeenStamps.size > 10_000) {
      for (const [id, stampedAt] of lastSeenStamps) {
        if (stampedAt < now - 5 * 60_000) lastSeenStamps.delete(id);
      }
    }
    await db.query(
      row.auth_kind === "device"
        ? `UPDATE device_authorizations SET last_used_at = now() WHERE id = $1`
        : `UPDATE agent_credentials SET last_used_at = now() WHERE id = $1`,
      [row.id],
    );
  }
  return {
    workspaceId: row.workspace_id,
    agentIdentityId: row.agent_identity_id,
    credentialId: row.auth_kind === "credential" ? row.id : null,
    deviceAuthorizationId: row.auth_kind === "device" ? row.id : null,
    scopes: row.scopes,
    platform: row.kind,
    contextDeliveryEnabled: row.context_delivery_enabled,
  };
}

export function hasScope(principal: AgentPrincipal, scope: AgentScope): boolean {
  return principal.scopes.includes(scope);
}
