import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentPlatform, AgentScope } from "termyte/protocol";
import { TERMYTE_PROTOCOL_VERSION } from "termyte/protocol";
import { issueAgentCredential } from "./agent-auth.js";
import { transaction, type Database } from "./db.js";
import { ConflictError, ForbiddenError, NotFoundError } from "./work.js";

const FLOW_TTL_MS = 10 * 60_000;
const POLL_INTERVAL_SECONDS = 3;

export async function startDeviceAuthorization(
  db: Database,
  pepper: string,
  appUrl: string,
  input: {
    device_name: string;
    platform: AgentPlatform;
    requested_scopes: AgentScope[];
  },
) {
  const deviceCode = randomBytes(32).toString("base64url");
  const userCode = `${codePart()}-${codePart()}`;
  await db.query(`
    INSERT INTO device_flow_requests (
      id, device_code_hash, user_code, device_name, platform,
      requested_scopes, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')
  `, [
    randomUUID(),
    hashDeviceCode(deviceCode, pepper),
    userCode,
    input.device_name,
    input.platform,
    input.requested_scopes,
  ]);
  const verificationUri = new URL("/device", appUrl).toString();
  const complete = new URL(verificationUri);
  complete.searchParams.set("code", userCode);
  return {
    schema_version: TERMYTE_PROTOCOL_VERSION,
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: complete.toString(),
    expires_in: FLOW_TTL_MS / 1_000,
    interval: POLL_INTERVAL_SECONDS,
  };
}

export async function approveDeviceAuthorization(
  db: Database,
  userId: string,
  input: {
    user_code: string;
    workspace_id: string;
    agent_identity_id?: string;
    agent_name?: string;
  },
) {
  return transaction(db, async (client) => {
    const membership = await client.query(`
      SELECT role FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL
    `, [input.workspace_id, userId]);
    if (!membership.rows[0]) throw new ForbiddenError();
    const flow = await client.query<{
      id: string;
      platform: AgentPlatform;
      status: string;
      expires_at: Date;
    }>(`
      SELECT id, platform, status, expires_at
      FROM device_flow_requests
      WHERE user_code = $1
      FOR UPDATE
    `, [input.user_code.toUpperCase()]);
    const row = flow.rows[0];
    if (!row) throw new NotFoundError();
    if (row.status !== "pending" || row.expires_at.getTime() <= Date.now()) {
      throw new ConflictError("Device authorization is no longer pending");
    }
    let agentIdentityId = input.agent_identity_id;
    if (agentIdentityId) {
      const identity = await client.query(`
        SELECT 1 FROM agent_identities
        WHERE id = $1 AND workspace_id = $2 AND kind = $3 AND status = 'active'
      `, [agentIdentityId, input.workspace_id, row.platform]);
      if (!identity.rows[0]) throw new NotFoundError();
    } else {
      agentIdentityId = randomUUID();
      await client.query(`
        INSERT INTO agent_identities (
          id, workspace_id, name, kind, created_by_user_id
        ) VALUES ($1, $2, $3, $4, $5)
      `, [
        agentIdentityId,
        input.workspace_id,
        input.agent_name?.trim() || `My ${row.platform}`,
        row.platform,
        userId,
      ]);
    }
    await client.query(`
      UPDATE device_flow_requests
      SET status = 'approved', workspace_id = $1, agent_identity_id = $2,
        authorized_by_user_id = $3
      WHERE id = $4
    `, [input.workspace_id, agentIdentityId, userId, row.id]);
    await client.query(`
      INSERT INTO audit_events (
        id, workspace_id, actor_type, actor_id, action, target_type, target_id, metadata_json
      ) VALUES ($1, $2, 'user', $3, 'device.approve', 'device_flow', $4, $5)
    `, [
      randomUUID(),
      input.workspace_id,
      userId,
      row.id,
      { agent_identity_id: agentIdentityId, platform: row.platform },
    ]);
    return { approved: true, agent_identity_id: agentIdentityId };
  });
}

export async function exchangeDeviceAuthorization(
  db: Database,
  pepper: string,
  deviceCode: string,
) {
  return transaction(db, async (client) => {
    const result = await client.query<{
      id: string;
      status: string;
      workspace_id: string | null;
      agent_identity_id: string | null;
      authorized_by_user_id: string | null;
      device_name: string;
      requested_scopes: AgentScope[];
      expires_at: Date;
    }>(`
      SELECT * FROM device_flow_requests
      WHERE device_code_hash = $1
      FOR UPDATE
    `, [hashDeviceCode(deviceCode, pepper)]);
    const row = result.rows[0];
    if (!row) throw new NotFoundError();
    if (row.expires_at.getTime() <= Date.now()) {
      throw new ConflictError("Device authorization expired");
    }
    if (row.status === "pending") {
      return {
        schema_version: TERMYTE_PROTOCOL_VERSION,
        state: "pending" as const,
        interval: POLL_INTERVAL_SECONDS,
      };
    }
    if (row.status !== "approved" || !row.workspace_id || !row.agent_identity_id
      || !row.authorized_by_user_id) {
      throw new ConflictError("Device authorization was already used or denied");
    }
    const issued = issueAgentCredential(pepper);
    const authorizationId = randomUUID();
    await client.query(`
      INSERT INTO device_authorizations (
        id, workspace_id, agent_identity_id, authorized_by_user_id,
        device_name, token_prefix, secret_hash, scopes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      authorizationId,
      row.workspace_id,
      row.agent_identity_id,
      row.authorized_by_user_id,
      row.device_name,
      issued.prefix,
      issued.secretHash,
      row.requested_scopes,
    ]);
    await client.query(`
      UPDATE device_flow_requests SET status = 'claimed', claimed_at = now()
      WHERE id = $1
    `, [row.id]);
    return {
      schema_version: TERMYTE_PROTOCOL_VERSION,
      state: "authorized" as const,
      credential: issued.token,
      workspace_id: row.workspace_id,
      agent_identity_id: row.agent_identity_id,
      scopes: row.requested_scopes,
    };
  });
}

function hashDeviceCode(value: string, pepper: string): Buffer {
  return createHash("sha256").update(value).update(pepper).digest();
}

function codePart(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(4), (byte) => alphabet[byte % alphabet.length]).join("");
}
