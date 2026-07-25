import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { AgentPlatform, AgentScope } from "termyte/protocol";
import { issueAgentCredential } from "./agent-auth.js";
import { transaction, type Database } from "./db.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  buildContextBriefing,
} from "./work.js";

export async function createWorkspace(
  db: Database,
  userId: string,
  input: { name: string; slug: string },
) {
  return transaction(db, async (client) => {
    const id = randomUUID();
    try {
      const result = await client.query(`
        INSERT INTO workspaces (id, name, slug, owner_user_id)
        VALUES ($1, $2, $3, $4)
        RETURNING id, name, slug, subscription_state, retention_days,
          context_delivery_enabled, created_at
      `, [id, input.name, input.slug, userId]);
      await client.query(`
        INSERT INTO workspace_memberships (workspace_id, user_id, role)
        VALUES ($1, $2, 'owner')
      `, [id, userId]);
      return result.rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ConflictError("Workspace slug is already in use");
      }
      throw error;
    }
  });
}

export async function listWorkspaces(db: Database, userId: string) {
  return (await db.query(`
    SELECT w.id, w.name, w.slug, w.subscription_state, w.retention_days,
      w.context_delivery_enabled,
      w.plan_override, w.plan_override_expires_at, w.deletion_requested_at,
      m.role, w.created_at
    FROM workspace_memberships m
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = $1 AND m.revoked_at IS NULL
    ORDER BY w.created_at
  `, [userId])).rows;
}

export async function getWorkspaceUsage(
  db: Database,
  userId: string,
  workspaceId: string,
) {
  await requireAdmin(db, userId, workspaceId);
  const usage = (await db.query<{
    source_events: number;
    context_briefings: number;
    outcomes: number;
    active_work_threads: number;
    agent_identities: number;
    plan_override: string | null;
    plan_override_expires_at: Date | null;
  }>(`
    SELECT
      (SELECT count(*)::integer FROM source_events
        WHERE workspace_id = $1
          AND received_at >= date_trunc('month', now())) AS source_events,
      (SELECT count(*)::integer FROM context_receipts
        WHERE workspace_id = $1
          AND created_at >= date_trunc('month', now())) AS context_briefings,
      (SELECT count(*)::integer FROM outcomes
        WHERE workspace_id = $1
          AND reported_at >= date_trunc('month', now())) AS outcomes,
      (SELECT count(*)::integer FROM work_threads
        WHERE workspace_id = $1 AND deleted_at IS NULL
          AND status IN ('proposed', 'active', 'blocked', 'in_review')) AS active_work_threads,
      (SELECT count(*)::integer FROM agent_identities
        WHERE workspace_id = $1 AND status = 'active') AS agent_identities,
      workspace.plan_override,
      workspace.plan_override_expires_at
    FROM workspaces workspace
    WHERE workspace.id = $1 AND workspace.deletion_requested_at IS NULL
  `, [workspaceId])).rows[0];
  if (!usage) throw new NotFoundError();
  return {
    period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    usage,
    fair_use: {
      source_events_per_month: 250_000,
      context_briefings_per_month: 25_000,
      agent_identities: 100,
      enforcement: "soft",
      overage_policy: "No automatic charge or shutdown; contact the customer before changing service.",
    },
  };
}

export async function createWorkspaceInvite(
  db: Database,
  userId: string,
  workspaceId: string,
  input: { email: string; role: "admin" | "member" },
) {
  await requireAdmin(db, userId, workspaceId);
  return transaction(db, async (client) => {
    const id = randomUUID();
    const token = `tyt_inv_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    await client.query(`
      INSERT INTO workspace_invites (
        id, workspace_id, email, role, token_hash,
        created_by_user_id, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      id,
      workspaceId,
      input.email.toLowerCase(),
      input.role,
      inviteHash(token),
      userId,
      expiresAt,
    ]);
    await audit(client, workspaceId, userId, "invite.create", "workspace_invite", id, {
      email: input.email.toLowerCase(),
      role: input.role,
    });
    return { id, token, email: input.email.toLowerCase(), role: input.role, expires_at: expiresAt };
  });
}

export async function listWorkspaceInvites(
  db: Database,
  userId: string,
  workspaceId: string,
) {
  await requireAdmin(db, userId, workspaceId);
  return (await db.query(`
    SELECT id, email, role, expires_at, accepted_by_user_id, accepted_at,
      revoked_at, created_at
    FROM workspace_invites
    WHERE workspace_id = $1
    ORDER BY created_at DESC
  `, [workspaceId])).rows;
}

export async function acceptWorkspaceInvite(
  db: Database,
  userId: string,
  token: string,
) {
  return transaction(db, async (client) => {
    const invite = (await client.query<{
      id: string;
      workspace_id: string;
      role: "admin" | "member";
      accepted_at: Date | null;
      revoked_at: Date | null;
      expires_at: Date;
    }>(`
      SELECT id, workspace_id, role, accepted_at, revoked_at, expires_at
      FROM workspace_invites
      WHERE token_hash = $1
      FOR UPDATE
    `, [inviteHash(token)])).rows[0];
    if (!invite || invite.revoked_at || invite.expires_at.getTime() <= Date.now()) {
      throw new NotFoundError();
    }
    if (invite.accepted_at) throw new ConflictError("Invite has already been accepted");
    await client.query(`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET
        role = excluded.role, revoked_at = NULL
    `, [invite.workspace_id, userId, invite.role]);
    await client.query(`
      UPDATE workspace_invites
      SET accepted_by_user_id = $1, accepted_at = now()
      WHERE id = $2
    `, [userId, invite.id]);
    await audit(
      client,
      invite.workspace_id,
      userId,
      "invite.accept",
      "workspace_invite",
      invite.id,
    );
    return { accepted: true, workspace_id: invite.workspace_id, role: invite.role };
  });
}

export async function revokeWorkspaceInvite(
  db: Database,
  userId: string,
  workspaceId: string,
  inviteId: string,
) {
  await requireAdmin(db, userId, workspaceId);
  return transaction(db, async (client) => {
    const result = await client.query(`
      UPDATE workspace_invites
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL
    `, [inviteId, workspaceId]);
    if (result.rowCount !== 1) throw new NotFoundError();
    await audit(client, workspaceId, userId, "invite.revoke", "workspace_invite", inviteId);
    return { revoked: true };
  });
}

function inviteHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export async function listWorkThreads(
  db: Database,
  userId: string,
  workspaceId: string,
  limit = 50,
) {
  await requireMembership(db, userId, workspaceId);
  return (await db.query(`
    SELECT w.id, w.title, w.objective, w.status, w.current_summary,
      w.repository_key, w.version, w.created_at, w.updated_at,
      count(DISTINCT se.id)::integer AS event_count,
      count(DISTINCT cr.id)::integer AS receipt_count
    FROM work_threads w
    LEFT JOIN source_events se
      ON se.workspace_id = w.workspace_id AND se.work_thread_id = w.id
    LEFT JOIN context_receipts cr
      ON cr.workspace_id = w.workspace_id AND cr.work_thread_id = w.id
    WHERE w.workspace_id = $1 AND w.deleted_at IS NULL
    GROUP BY w.id
    ORDER BY w.updated_at DESC
    LIMIT $2
  `, [workspaceId, Math.min(100, Math.max(1, limit))])).rows;
}

export async function listResolutionAttempts(
  db: Database,
  userId: string,
  workspaceId: string,
  limit = 50,
) {
  await requireMembership(db, userId, workspaceId);
  return (await db.query(`
    SELECT attempt.id, attempt.request_text, attempt.state, attempt.response_json,
      attempt.created_at, attempt.resolved_at,
      agent.id AS agent_identity_id, agent.name AS agent_name, agent.kind AS agent_kind
    FROM context_resolution_attempts attempt
    JOIN agent_identities agent
      ON agent.id = attempt.agent_identity_id
      AND agent.workspace_id = attempt.workspace_id
    WHERE attempt.workspace_id = $1 AND attempt.resolved_at IS NULL
    ORDER BY attempt.created_at DESC
    LIMIT $2
  `, [workspaceId, Math.min(100, Math.max(1, limit))])).rows;
}

export async function resolveResolutionAttempt(
  db: Database,
  userId: string,
  workspaceId: string,
  attemptId: string,
) {
  return transaction(db, async (client) => {
    await requireMembership(client, userId, workspaceId);
    const result = await client.query(`
      UPDATE context_resolution_attempts
      SET resolved_at = COALESCE(resolved_at, now())
      WHERE id = $1 AND workspace_id = $2
    `, [attemptId, workspaceId]);
    if (result.rowCount !== 1) throw new NotFoundError();
    await audit(
      client,
      workspaceId,
      userId,
      "resolution_attempt.resolve",
      "context_resolution_attempt",
      attemptId,
    );
    return { resolved: true };
  });
}

export async function getWorkThread(
  db: Database,
  userId: string,
  workspaceId: string,
  workThreadId: string,
) {
  await requireMembership(db, userId, workspaceId);
  const work = (await db.query(`
    SELECT * FROM work_threads
    WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
  `, [workThreadId, workspaceId])).rows[0];
  if (!work) throw new NotFoundError();
  const [items, handoffs, receipts, outcomes, links, sources] = await Promise.all([
    db.query(`
      SELECT ci.*,
        coalesce(array_agg(se.external_id ORDER BY se.occurred_at)
          FILTER (WHERE se.id IS NOT NULL), '{}') AS source_event_ids,
        coalesce((
          SELECT array_agg(r.agent_identity_id ORDER BY r.agent_identity_id)
          FROM context_item_agent_restrictions r
          WHERE r.context_item_id = ci.id
        ), '{}') AS restricted_to_agent_identity_ids
      FROM context_items ci
      LEFT JOIN context_item_sources cis ON cis.context_item_id = ci.id
      LEFT JOIN source_events se
        ON se.id = cis.source_event_id AND se.workspace_id = ci.workspace_id
      WHERE ci.workspace_id = $1 AND ci.work_thread_id = $2
      GROUP BY ci.id
      ORDER BY ci.updated_at DESC
    `, [workspaceId, workThreadId]),
    db.query(`
      SELECT h.*, source.name AS from_agent_name, target.name AS to_agent_name
      FROM handoffs h
      JOIN agent_identities source ON source.id = h.from_agent_identity_id
      JOIN agent_identities target ON target.id = h.to_agent_identity_id
      WHERE h.workspace_id = $1 AND h.work_thread_id = $2
      ORDER BY h.created_at DESC
    `, [workspaceId, workThreadId]),
    db.query(`
      SELECT cr.id, cr.request_text, cr.resolution_state, cr.briefing_text,
        cr.briefing_token_count, cr.work_thread_version, cr.created_at,
        cr.delivered_at, cr.acknowledged_at, a.name AS agent_name,
        count(cri.context_item_id)::integer AS item_count
      FROM context_receipts cr
      JOIN agent_identities a ON a.id = cr.agent_identity_id
      LEFT JOIN context_receipt_items cri ON cri.receipt_id = cr.id
      WHERE cr.workspace_id = $1 AND cr.work_thread_id = $2
      GROUP BY cr.id, a.name
      ORDER BY cr.created_at DESC
    `, [workspaceId, workThreadId]),
    db.query(`
      SELECT o.*, a.name AS agent_name
      FROM outcomes o
      JOIN agent_identities a ON a.id = o.agent_identity_id
      WHERE o.workspace_id = $1 AND o.work_thread_id = $2
      ORDER BY o.reported_at DESC
    `, [workspaceId, workThreadId]),
    db.query(`
      SELECT id, source_work_thread_id, target_work_thread_id, kind,
        created_by_user_id, created_at
      FROM work_thread_links
      WHERE workspace_id = $1
        AND (source_work_thread_id = $2 OR target_work_thread_id = $2)
      ORDER BY created_at DESC
    `, [workspaceId, workThreadId]),
    db.query(`
      SELECT se.id, se.source, se.external_id, se.event_type, se.payload_text,
        se.canonical_url, se.occurred_at, se.provider_updated_at,
        c.name AS connector_name
      FROM source_events se
      LEFT JOIN connector_connections c
        ON c.id = se.connector_connection_id AND c.workspace_id = se.workspace_id
      WHERE se.workspace_id = $1 AND se.work_thread_id = $2
      ORDER BY se.occurred_at DESC
    `, [workspaceId, workThreadId]),
  ]);
  await db.query(`
    INSERT INTO audit_events (
      id, workspace_id, actor_type, actor_id, action,
      target_type, target_id, metadata_json
    ) VALUES ($1, $2, 'user', $3, 'work_thread.read', 'work_thread', $4, '{}')
  `, [randomUUID(), workspaceId, userId, workThreadId]);
  return {
    work_thread: work,
    context_items: items.rows,
    handoffs: handoffs.rows,
    receipts: receipts.rows,
    outcomes: outcomes.rows,
    links: links.rows,
    sources: sources.rows,
  };
}

export async function getReceipt(
  db: Database,
  userId: string,
  workspaceId: string,
  receiptId: string,
) {
  await requireMembership(db, userId, workspaceId);
  const receipt = (await db.query(`
    SELECT cr.*, a.name AS agent_name, a.kind AS agent_kind
    FROM context_receipts cr
    JOIN agent_identities a ON a.id = cr.agent_identity_id
    WHERE cr.id = $1 AND cr.workspace_id = $2
  `, [receiptId, workspaceId])).rows[0];
  if (!receipt) throw new NotFoundError();
  const items = await db.query(`
    SELECT cri.position, cri.inclusion_reason, cri.source_snapshot_json,
      ci.type, ci.state AS current_state, ci.text AS current_text
    FROM context_receipt_items cri
    LEFT JOIN context_items ci ON ci.id = cri.context_item_id
    WHERE cri.receipt_id = $1
    ORDER BY cri.position
  `, [receiptId]);
  await db.query(`
    INSERT INTO audit_events (
      id, workspace_id, actor_type, actor_id, action,
      target_type, target_id, metadata_json
    ) VALUES ($1, $2, 'user', $3, 'receipt.read', 'context_receipt', $4, '{}')
  `, [randomUUID(), workspaceId, userId, receiptId]);
  return { receipt, items: items.rows };
}

export async function previewContextBriefing(
  db: Database,
  userId: string,
  workspaceId: string,
  workThreadId: string,
  agentIdentityId: string,
  tokenBudget: number,
) {
  await requireMembership(db, userId, workspaceId);
  return transaction(db, async (client) => {
    const target = (await client.query<{
      id: string;
      title: string;
      objective: string;
      current_summary: string | null;
      version: number;
      workspace_delivery_enabled: boolean;
      work_delivery_enabled: boolean;
      agent_delivery_enabled: boolean;
      agent_status: string;
      can_read_context: boolean | null;
      grant_revoked_at: Date | null;
    }>(`
      SELECT w.id, w.title, w.objective, w.current_summary, w.version,
        workspace.context_delivery_enabled AS workspace_delivery_enabled,
        w.context_delivery_enabled AS work_delivery_enabled,
        agent.context_delivery_enabled AS agent_delivery_enabled,
        agent.status AS agent_status,
        work_grant.can_read_context,
        work_grant.revoked_at AS grant_revoked_at
      FROM work_threads w
      JOIN workspaces workspace ON workspace.id = w.workspace_id
      JOIN agent_identities agent
        ON agent.id = $3 AND agent.workspace_id = w.workspace_id
      LEFT JOIN work_thread_agent_grants work_grant
        ON work_grant.workspace_id = w.workspace_id
        AND work_grant.work_thread_id = w.id
        AND work_grant.agent_identity_id = agent.id
      WHERE w.id = $1 AND w.workspace_id = $2 AND w.deleted_at IS NULL
    `, [workThreadId, workspaceId, agentIdentityId])).rows[0];
    if (!target) throw new NotFoundError();

    const blockedReason = !target.workspace_delivery_enabled
      ? "Context delivery is disabled for the workspace."
      : target.agent_status !== "active"
        ? "The selected Agent Identity is disabled."
        : !target.agent_delivery_enabled
          ? "Context delivery is disabled for the selected Agent Identity."
          : !target.work_delivery_enabled
            ? "Context delivery is disabled for this Work Thread."
            : !target.can_read_context || target.grant_revoked_at
              ? "The selected Agent Identity does not have an active context grant."
              : null;

    const items = blockedReason ? [] : (await client.query<{
      id: string;
      type:
        | "objective" | "current_state" | "decision" | "constraint"
        | "observation" | "attempt" | "failure" | "blocker"
        | "evidence" | "expected_result" | "next_action" | "outcome";
      text: string;
      authority: number;
      source_event_ids: string[];
    }>(`
      SELECT ci.*, array_agg(cis.source_event_id ORDER BY cis.source_event_id)
        FILTER (WHERE cis.source_event_id IS NOT NULL) AS source_event_ids
      FROM context_items ci
      LEFT JOIN context_item_sources cis ON cis.context_item_id = ci.id
      WHERE ci.workspace_id = $1 AND ci.work_thread_id = $2 AND ci.state = 'active'
        AND (ci.valid_until IS NULL OR ci.valid_until > now())
        AND ci.confidence >= 0.5
        AND (
          NOT EXISTS (
            SELECT 1 FROM context_item_agent_restrictions restriction
            WHERE restriction.context_item_id = ci.id
          )
          OR EXISTS (
            SELECT 1 FROM context_item_agent_restrictions restriction
            WHERE restriction.context_item_id = ci.id
              AND restriction.workspace_id = ci.workspace_id
              AND restriction.agent_identity_id = $3
          )
        )
      GROUP BY ci.id
      HAVING count(cis.source_event_id) > 0
      ORDER BY CASE ci.type
          WHEN 'constraint' THEN 1 WHEN 'decision' THEN 2 WHEN 'blocker' THEN 3
          WHEN 'failure' THEN 4 WHEN 'expected_result' THEN 5 WHEN 'evidence' THEN 6
          WHEN 'next_action' THEN 7 WHEN 'current_state' THEN 8
          WHEN 'outcome' THEN 9 WHEN 'attempt' THEN 10 ELSE 11
        END,
        ci.authority DESC,
        ci.updated_at DESC
      LIMIT 100
    `, [workspaceId, workThreadId, agentIdentityId])).rows;

    const briefing = blockedReason
      ? null
      : buildContextBriefing(target, items, tokenBudget);
    await audit(
      client,
      workspaceId,
      userId,
      "context.preview",
      "work_thread",
      workThreadId,
      {
        agent_identity_id: agentIdentityId,
        deliverable: blockedReason === null,
        blocked_reason: blockedReason,
      },
    );
    return {
      work_thread_id: workThreadId,
      work_thread_version: target.version,
      agent_identity_id: agentIdentityId,
      deliverable: blockedReason === null,
      blocked_reason: blockedReason,
      briefing: briefing?.text ?? null,
      estimated_tokens: briefing?.tokens ?? 0,
      sources: briefing?.items.map((item) => ({
        context_item_id: item.id,
        type: item.type,
        source_event_ids: item.source_event_ids,
        inclusion_reason: `Active ${item.type} for the selected Work Thread`,
      })) ?? [],
    };
  });
}

export async function confirmOutcome(
  db: Database,
  userId: string,
  workspaceId: string,
  outcomeId: string,
) {
  await requireAdmin(db, userId, workspaceId);
  return transaction(db, async (client) => {
    const outcome = (await client.query<{
      id: string;
      work_thread_id: string;
      summary: string;
      status: string;
    }>(`
      SELECT id, work_thread_id, summary, status
      FROM outcomes
      WHERE id = $1 AND workspace_id = $2
    `, [outcomeId, workspaceId])).rows[0];
    if (!outcome) throw new NotFoundError();
    if (outcome.status !== "succeeded") {
      throw new ConflictError("Only a successful outcome can be confirmed");
    }
    await client.query(`
      UPDATE work_threads
      SET status = 'completed', current_summary = $1,
        version = version + 1, updated_at = now()
      WHERE id = $2 AND workspace_id = $3 AND deleted_at IS NULL
    `, [outcome.summary, outcome.work_thread_id, workspaceId]);
    const contextItemId = randomUUID();
    await client.query(`
      INSERT INTO context_items (
        id, workspace_id, work_thread_id, type, text, authority,
        confidence, state, created_by_user_id
      ) VALUES ($1, $2, $3, 'outcome', $4, 5, 1, 'active', $5)
    `, [contextItemId, workspaceId, outcome.work_thread_id, outcome.summary, userId]);
    await audit(
      client,
      workspaceId,
      userId,
      "outcome.confirm",
      "outcome",
      outcomeId,
      { work_thread_id: outcome.work_thread_id },
    );
    return {
      confirmed: true,
      outcome_id: outcomeId,
      work_thread_id: outcome.work_thread_id,
    };
  });
}

export async function correctContextItem(
  db: Database,
  userId: string,
  workspaceId: string,
  workThreadId: string,
  contextItemId: string,
  input: { action: "edit" | "incorrect" | "outdated" | "delete"; text?: string },
) {
  return transaction(db, async (client) => {
    await requireMembership(client, userId, workspaceId);
    const current = (await client.query(`
      SELECT * FROM context_items
      WHERE id = $1 AND workspace_id = $2 AND work_thread_id = $3
      FOR UPDATE
    `, [contextItemId, workspaceId, workThreadId])).rows[0];
    if (!current) throw new NotFoundError();
    if (input.action === "edit" && !input.text?.trim()) {
      throw new ConflictError("Edited context requires replacement text");
    }
    const state = input.action === "incorrect"
      ? "contradicted"
      : input.action === "outdated"
        ? "superseded"
        : input.action === "delete"
          ? "deleted"
          : "active";
    const text = input.action === "edit" ? input.text!.trim() : current.text;
    const correctionId = randomUUID();
    await client.query(`
      INSERT INTO corrections (
        id, workspace_id, work_thread_id, context_item_id, action,
        previous_value_json, new_value_json, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      correctionId,
      workspaceId,
      workThreadId,
      contextItemId,
      input.action,
      { text: current.text, state: current.state, authority: current.authority },
      { text, state, authority: 100 },
      userId,
    ]);
    await client.query(`
      UPDATE context_items
      SET text = $1, state = $2, authority = 100, confidence = 1,
        created_by_user_id = $3, updated_at = now()
      WHERE id = $4
    `, [text, state, userId, contextItemId]);
    await client.query(`
      UPDATE work_threads SET version = version + 1, updated_at = now()
      WHERE id = $1 AND workspace_id = $2
    `, [workThreadId, workspaceId]);
    await audit(client, workspaceId, userId, `context.${input.action}`, "context_item", contextItemId, {
      correction_id: correctionId,
    });
    return { corrected: true, correction_id: correctionId, state, text };
  });
}

export async function listAgents(db: Database, userId: string, workspaceId: string) {
  await requireMembership(db, userId, workspaceId);
  const [agents, devices, credentials, sessions, grants] = await Promise.all([
    db.query(`
      SELECT a.id, a.name, a.kind, a.status, a.created_at,
        count(DISTINCT s.id)::integer AS session_count
      FROM agent_identities a
      LEFT JOIN agent_sessions s
        ON s.workspace_id = a.workspace_id AND s.agent_identity_id = a.id
      WHERE a.workspace_id = $1
      GROUP BY a.id
      ORDER BY a.created_at
    `, [workspaceId]),
    db.query(`
      SELECT d.id, d.agent_identity_id, d.device_name, d.scopes, d.last_used_at,
        d.expires_at, d.revoked_at, d.created_at
      FROM device_authorizations d
      WHERE d.workspace_id = $1
      ORDER BY d.created_at DESC
    `, [workspaceId]),
    db.query(`
      SELECT id, agent_identity_id, token_prefix, scopes, expires_at,
        last_used_at, revoked_at, created_at
      FROM agent_credentials
      WHERE workspace_id = $1
      ORDER BY created_at DESC
    `, [workspaceId]),
    db.query(`
      SELECT id, agent_identity_id, source_session_id, source_platform,
        started_at, last_event_at
      FROM agent_sessions
      WHERE workspace_id = $1
      ORDER BY last_event_at DESC
      LIMIT 500
    `, [workspaceId]),
    db.query(`
      SELECT id, work_thread_id, agent_identity_id, can_read_context,
        can_append_events, can_create_handoff, source, created_at, revoked_at
      FROM work_thread_agent_grants
      WHERE workspace_id = $1
      ORDER BY created_at DESC
    `, [workspaceId]),
  ]);
  return {
    agents: agents.rows,
    devices: devices.rows,
    credentials: credentials.rows,
    sessions: sessions.rows,
    grants: grants.rows,
  };
}

export async function listMembers(db: Database, userId: string, workspaceId: string) {
  await requireMembership(db, userId, workspaceId);
  return (await db.query(`
    SELECT user_id, role, created_at, revoked_at
    FROM workspace_memberships
    WHERE workspace_id = $1
    ORDER BY created_at
  `, [workspaceId])).rows;
}

export async function addMember(
  db: Database,
  userId: string,
  workspaceId: string,
  input: { userId: string; role: "admin" | "member" },
) {
  return transaction(db, async (client) => {
    const actor = await requireMembership(client, userId, workspaceId);
    if (actor.role === "member" || (input.role === "admin" && actor.role !== "owner")) {
      throw new ForbiddenError();
    }
    await client.query(`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (workspace_id, user_id)
      DO UPDATE SET role = excluded.role, revoked_at = NULL
    `, [workspaceId, input.userId, input.role]);
    await audit(client, workspaceId, userId, "member.add", "user", input.userId, {
      role: input.role,
    });
    return { user_id: input.userId, role: input.role };
  });
}

export async function removeMember(
  db: Database,
  userId: string,
  workspaceId: string,
  memberUserId: string,
) {
  return transaction(db, async (client) => {
    const actor = await requireMembership(client, userId, workspaceId);
    if (actor.role === "member") throw new ForbiddenError();
    const target = (await client.query(`
      SELECT role FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL
      FOR UPDATE
    `, [workspaceId, memberUserId])).rows[0] as { role: string } | undefined;
    if (!target) throw new NotFoundError();
    if (target.role === "owner" || (target.role === "admin" && actor.role !== "owner")) {
      throw new ForbiddenError();
    }
    await client.query(`
      UPDATE workspace_memberships SET revoked_at = now()
      WHERE workspace_id = $1 AND user_id = $2
    `, [workspaceId, memberUserId]);
    await audit(client, workspaceId, userId, "member.remove", "user", memberUserId);
    return { removed: true };
  });
}

export async function createAgentIdentity(
  db: Database,
  userId: string,
  workspaceId: string,
  input: { name: string; kind: AgentPlatform },
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const id = randomUUID();
    const row = (await client.query(`
      INSERT INTO agent_identities (
        id, workspace_id, name, kind, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, kind, status, created_at
    `, [id, workspaceId, input.name, input.kind, userId])).rows[0];
    await audit(client, workspaceId, userId, "agent.create", "agent_identity", id);
    return row;
  });
}

export async function createAgentCredential(
  db: Database,
  pepper: string,
  userId: string,
  workspaceId: string,
  input: {
    agentIdentityId: string;
    scopes: AgentScope[];
    expiresAt?: Date;
  },
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const agent = await client.query(`
      SELECT 1 FROM agent_identities
      WHERE id = $1 AND workspace_id = $2 AND status = 'active'
    `, [input.agentIdentityId, workspaceId]);
    if (!agent.rows[0]) throw new NotFoundError();
    const issued = issueAgentCredential(pepper);
    const id = randomUUID();
    await client.query(`
      INSERT INTO agent_credentials (
        id, workspace_id, agent_identity_id, token_prefix, secret_hash,
        scopes, created_by_user_id, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      id,
      workspaceId,
      input.agentIdentityId,
      issued.prefix,
      issued.secretHash,
      input.scopes,
      userId,
      input.expiresAt ?? null,
    ]);
    await audit(client, workspaceId, userId, "credential.create", "agent_credential", id, {
      agent_identity_id: input.agentIdentityId,
      scopes: input.scopes,
    });
    return {
      id,
      agent_identity_id: input.agentIdentityId,
      token: issued.token,
      prefix: issued.prefix,
      scopes: input.scopes,
      expires_at: input.expiresAt ?? null,
    };
  });
}

export async function rotateAgentCredential(
  db: Database,
  pepper: string,
  userId: string,
  workspaceId: string,
  credentialId: string,
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const current = (await client.query<{
      agent_identity_id: string;
      scopes: AgentScope[];
      expires_at: Date | null;
    }>(`
      SELECT agent_identity_id, scopes, expires_at
      FROM agent_credentials
      WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL
      FOR UPDATE
    `, [credentialId, workspaceId])).rows[0];
    if (!current) throw new NotFoundError();
    const issued = issueAgentCredential(pepper);
    const replacementId = randomUUID();
    await client.query(`
      INSERT INTO agent_credentials (
        id, workspace_id, agent_identity_id, token_prefix, secret_hash,
        scopes, created_by_user_id, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      replacementId,
      workspaceId,
      current.agent_identity_id,
      issued.prefix,
      issued.secretHash,
      current.scopes,
      userId,
      current.expires_at,
    ]);
    await client.query(`
      UPDATE agent_credentials SET revoked_at = now()
      WHERE id = $1
    `, [credentialId]);
    await audit(client, workspaceId, userId, "credential.rotate", "agent_credential", credentialId, {
      replacement_id: replacementId,
    });
    return {
      id: replacementId,
      replaces: credentialId,
      agent_identity_id: current.agent_identity_id,
      token: issued.token,
      prefix: issued.prefix,
      scopes: current.scopes,
      expires_at: current.expires_at,
    };
  });
}

export async function revokeAgentCredential(
  db: Database,
  userId: string,
  workspaceId: string,
  credentialId: string,
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const result = await client.query(`
      UPDATE agent_credentials SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND workspace_id = $2
    `, [credentialId, workspaceId]);
    if (result.rowCount !== 1) throw new NotFoundError();
    await audit(client, workspaceId, userId, "credential.revoke", "agent_credential", credentialId);
    return { revoked: true };
  });
}

export async function setAgentStatus(
  db: Database,
  userId: string,
  workspaceId: string,
  agentIdentityId: string,
  status: "active" | "disabled",
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const result = await client.query(`
      UPDATE agent_identities SET status = $1
      WHERE id = $2 AND workspace_id = $3
    `, [status, agentIdentityId, workspaceId]);
    if (result.rowCount !== 1) throw new NotFoundError();
    await audit(client, workspaceId, userId, `agent.${status}`, "agent_identity", agentIdentityId);
    return { status };
  });
}

export async function grantWorkThreadAccess(
  db: Database,
  userId: string,
  workspaceId: string,
  workThreadId: string,
  input: {
    agentIdentityId: string;
    canReadContext: boolean;
    canAppendEvents: boolean;
    canCreateHandoff: boolean;
  },
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const valid = await client.query(`
      SELECT 1
      FROM work_threads w
      JOIN agent_identities a ON a.workspace_id = w.workspace_id
      WHERE w.id = $1 AND w.workspace_id = $2 AND w.deleted_at IS NULL
        AND a.id = $3 AND a.status = 'active'
    `, [workThreadId, workspaceId, input.agentIdentityId]);
    if (!valid.rows[0]) throw new NotFoundError();
    await client.query(`
      UPDATE work_thread_agent_grants SET revoked_at = now()
      WHERE work_thread_id = $1 AND agent_identity_id = $2 AND revoked_at IS NULL
    `, [workThreadId, input.agentIdentityId]);
    const id = randomUUID();
    await client.query(`
      INSERT INTO work_thread_agent_grants (
        id, workspace_id, work_thread_id, agent_identity_id,
        can_read_context, can_append_events, can_create_handoff,
        source, granted_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'human', $8)
    `, [
      id,
      workspaceId,
      workThreadId,
      input.agentIdentityId,
      input.canReadContext,
      input.canAppendEvents,
      input.canCreateHandoff,
      userId,
    ]);
    await audit(client, workspaceId, userId, "grant.create", "work_thread_grant", id, {
      work_thread_id: workThreadId,
      agent_identity_id: input.agentIdentityId,
    });
    return { id, ...input };
  });
}

export async function revokeWorkThreadAccess(
  db: Database,
  userId: string,
  workspaceId: string,
  grantId: string,
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const result = await client.query(`
      UPDATE work_thread_agent_grants SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND workspace_id = $2
    `, [grantId, workspaceId]);
    if (result.rowCount !== 1) throw new NotFoundError();
    await audit(client, workspaceId, userId, "grant.revoke", "work_thread_grant", grantId);
    return { revoked: true };
  });
}

export async function listAuditEvents(
  db: Database,
  userId: string,
  workspaceId: string,
  limit = 100,
) {
  await requireAdmin(db, userId, workspaceId);
  return (await db.query(`
    SELECT id, actor_type, actor_id, action, target_type, target_id,
      metadata_json, occurred_at
    FROM audit_events
    WHERE workspace_id = $1
    ORDER BY occurred_at DESC
    LIMIT $2
  `, [workspaceId, Math.min(500, Math.max(1, limit))])).rows;
}

export async function restrictContextItem(
  db: Database,
  userId: string,
  workspaceId: string,
  workThreadId: string,
  contextItemId: string,
  agentIdentityIds: string[],
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const item = await client.query(`
      SELECT 1 FROM context_items
      WHERE id = $1 AND workspace_id = $2 AND work_thread_id = $3
      FOR UPDATE
    `, [contextItemId, workspaceId, workThreadId]);
    if (!item.rows[0]) throw new NotFoundError();
    if (agentIdentityIds.length > 0) {
      const valid = await client.query<{ id: string }>(`
        SELECT id FROM agent_identities
        WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'
      `, [workspaceId, agentIdentityIds]);
      if (valid.rows.length !== agentIdentityIds.length) throw new NotFoundError();
    }
    await client.query(`
      DELETE FROM context_item_agent_restrictions
      WHERE context_item_id = $1
    `, [contextItemId]);
    for (const agentIdentityId of agentIdentityIds) {
      await client.query(`
        INSERT INTO context_item_agent_restrictions (
          workspace_id, context_item_id, agent_identity_id, created_by_user_id
        ) VALUES ($1, $2, $3, $4)
      `, [workspaceId, contextItemId, agentIdentityId, userId]);
    }
    await client.query(`
      UPDATE work_threads SET version = version + 1, updated_at = now()
      WHERE id = $1 AND workspace_id = $2
    `, [workThreadId, workspaceId]);
    await audit(client, workspaceId, userId, "context.restrict", "context_item", contextItemId, {
      agent_identity_ids: agentIdentityIds,
    });
    return { restricted_to_agent_identity_ids: agentIdentityIds };
  });
}

export async function mergeWorkThreads(
  db: Database,
  userId: string,
  workspaceId: string,
  sourceWorkThreadId: string,
  targetWorkThreadId: string,
) {
  if (sourceWorkThreadId === targetWorkThreadId) {
    throw new ConflictError("A Work Thread cannot be merged into itself");
  }
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const locked = await client.query<{ id: string }>(`
      SELECT id FROM work_threads
      WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL
      ORDER BY id FOR UPDATE
    `, [workspaceId, [sourceWorkThreadId, targetWorkThreadId]]);
    if (locked.rows.length !== 2) throw new NotFoundError();
    await client.query(`
      UPDATE source_events SET work_thread_id = $1
      WHERE workspace_id = $2 AND work_thread_id = $3
    `, [targetWorkThreadId, workspaceId, sourceWorkThreadId]);
    await client.query(`
      UPDATE context_items SET work_thread_id = $1, updated_at = now()
      WHERE workspace_id = $2 AND work_thread_id = $3
    `, [targetWorkThreadId, workspaceId, sourceWorkThreadId]);
    await client.query(`
      INSERT INTO work_thread_agent_grants (
        id, workspace_id, work_thread_id, agent_identity_id,
        can_read_context, can_append_events, can_create_handoff,
        source, granted_by_user_id
      )
      SELECT gen_random_uuid(), workspace_id, $1, agent_identity_id,
        can_read_context, can_append_events, can_create_handoff, 'human', $4
      FROM work_thread_agent_grants source_grant
      WHERE workspace_id = $2 AND work_thread_id = $3 AND revoked_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM work_thread_agent_grants target_grant
          WHERE target_grant.work_thread_id = $1
            AND target_grant.agent_identity_id = source_grant.agent_identity_id
            AND target_grant.revoked_at IS NULL
        )
    `, [targetWorkThreadId, workspaceId, sourceWorkThreadId, userId]);
    await client.query(`
      UPDATE work_thread_agent_grants SET revoked_at = now()
      WHERE workspace_id = $1 AND work_thread_id = $2 AND revoked_at IS NULL
    `, [workspaceId, sourceWorkThreadId]);
    const linkId = randomUUID();
    await client.query(`
      INSERT INTO work_thread_links (
        id, workspace_id, source_work_thread_id, target_work_thread_id,
        kind, created_by_user_id
      ) VALUES ($1, $2, $3, $4, 'merged_into', $5)
    `, [linkId, workspaceId, sourceWorkThreadId, targetWorkThreadId, userId]);
    await client.query(`
      UPDATE work_threads
      SET status = 'archived', archived_at = now(),
        current_summary = $1, version = version + 1, updated_at = now()
      WHERE id = $2 AND workspace_id = $3
    `, [`Merged into ${targetWorkThreadId}`, sourceWorkThreadId, workspaceId]);
    await client.query(`
      UPDATE work_threads SET version = version + 1, updated_at = now()
      WHERE id = $1 AND workspace_id = $2
    `, [targetWorkThreadId, workspaceId]);
    await audit(client, workspaceId, userId, "work_thread.merge", "work_thread", sourceWorkThreadId, {
      target_work_thread_id: targetWorkThreadId,
      link_id: linkId,
    });
    return { merged: true, source_work_thread_id: sourceWorkThreadId, target_work_thread_id: targetWorkThreadId };
  });
}

export async function splitWorkThread(
  db: Database,
  userId: string,
  workspaceId: string,
  sourceWorkThreadId: string,
  input: {
    title: string;
    objective: string;
    sourceEventIds: string[];
    idempotencyKey: string;
  },
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const source = await client.query(`
      SELECT 1 FROM work_threads
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
      FOR UPDATE
    `, [sourceWorkThreadId, workspaceId]);
    if (!source.rows[0]) throw new NotFoundError();
    const events = await client.query<{ id: string }>(`
      SELECT id FROM source_events
      WHERE workspace_id = $1 AND work_thread_id = $2
        AND id = ANY($3::uuid[])
      FOR UPDATE
    `, [workspaceId, sourceWorkThreadId, input.sourceEventIds]);
    if (events.rows.length !== input.sourceEventIds.length) throw new NotFoundError();
    const newId = randomUUID();
    try {
      await client.query(`
        INSERT INTO work_threads (
          id, workspace_id, title, objective, status, idempotency_key,
          created_by_user_id
        ) VALUES ($1, $2, $3, $4, 'active', $5, $6)
      `, [newId, workspaceId, input.title, input.objective, input.idempotencyKey, userId]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ConflictError("Split idempotency key is already in use");
      }
      throw error;
    }
    await client.query(`
      UPDATE source_events SET work_thread_id = $1
      WHERE workspace_id = $2 AND id = ANY($3::uuid[])
    `, [newId, workspaceId, input.sourceEventIds]);
    await client.query(`
      UPDATE context_items ci SET work_thread_id = $1, updated_at = now()
      WHERE ci.workspace_id = $2 AND ci.work_thread_id = $3
        AND EXISTS (
          SELECT 1 FROM context_item_sources cis
          WHERE cis.context_item_id = ci.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM context_item_sources cis
          WHERE cis.context_item_id = ci.id
            AND cis.source_event_id <> ALL($4::uuid[])
        )
    `, [newId, workspaceId, sourceWorkThreadId, input.sourceEventIds]);
    await client.query(`
      INSERT INTO work_thread_agent_grants (
        id, workspace_id, work_thread_id, agent_identity_id,
        can_read_context, can_append_events, can_create_handoff,
        source, granted_by_user_id
      )
      SELECT gen_random_uuid(), workspace_id, $1, agent_identity_id,
        can_read_context, can_append_events, can_create_handoff, 'human', $4
      FROM work_thread_agent_grants
      WHERE workspace_id = $2 AND work_thread_id = $3 AND revoked_at IS NULL
    `, [newId, workspaceId, sourceWorkThreadId, userId]);
    const linkId = randomUUID();
    await client.query(`
      INSERT INTO work_thread_links (
        id, workspace_id, source_work_thread_id, target_work_thread_id,
        kind, created_by_user_id
      ) VALUES ($1, $2, $3, $4, 'split_from', $5)
    `, [linkId, workspaceId, sourceWorkThreadId, newId, userId]);
    await client.query(`
      UPDATE work_threads SET version = version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = ANY($2::uuid[])
    `, [workspaceId, [sourceWorkThreadId, newId]]);
    await audit(client, workspaceId, userId, "work_thread.split", "work_thread", sourceWorkThreadId, {
      target_work_thread_id: newId,
      source_event_ids: input.sourceEventIds,
      link_id: linkId,
    });
    return { work_thread_id: newId, source_work_thread_id: sourceWorkThreadId };
  });
}

export async function revokeDevice(
  db: Database,
  userId: string,
  workspaceId: string,
  deviceId: string,
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const result = await client.query(`
      UPDATE device_authorizations
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND workspace_id = $2
    `, [deviceId, workspaceId]);
    if (result.rowCount !== 1) throw new NotFoundError();
    await audit(client, workspaceId, userId, "device.revoke", "device", deviceId);
    return { revoked: true };
  });
}

export async function exportWorkspace(
  db: Database,
  userId: string,
  workspaceId: string,
) {
  await requireMembership(db, userId, workspaceId);
  const tables = [
    "work_threads",
    "work_thread_agent_grants",
    "work_thread_links",
    "context_items",
    "context_item_agent_restrictions",
    "source_events",
    "handoffs",
    "context_receipts",
    "context_resolution_attempts",
    "outcomes",
    "corrections",
    "agent_identities",
    "agent_sessions",
    "workspace_memberships",
    "stripe_customers",
    "audit_events",
  ] as const;
  const data: Record<string, unknown[]> = {};
  for (const table of tables) {
    data[table] = (await db.query(`SELECT * FROM ${table} WHERE workspace_id = $1`, [
      workspaceId,
    ])).rows;
  }
  const receiptIds = (data["context_receipts"] ?? []).map((row) =>
    (row as { id: string }).id);
  data["context_receipt_items"] = receiptIds.length === 0 ? [] : (await db.query(`
    SELECT * FROM context_receipt_items WHERE receipt_id = ANY($1::uuid[])
  `, [receiptIds])).rows;
  data["agent_credentials"] = (await db.query(`
    SELECT id, workspace_id, agent_identity_id, token_prefix, scopes,
      expires_at, last_used_at, revoked_at, created_at
    FROM agent_credentials WHERE workspace_id = $1
  `, [workspaceId])).rows;
  data["device_authorizations"] = (await db.query(`
    SELECT id, workspace_id, agent_identity_id, device_name, token_prefix,
      scopes, expires_at, last_used_at, revoked_at, created_at
    FROM device_authorizations WHERE workspace_id = $1
  `, [workspaceId])).rows;
  data["workspace_invites"] = (await db.query(`
    SELECT id, workspace_id, email, role, created_by_user_id, expires_at,
      accepted_by_user_id, accepted_at, revoked_at, created_at
    FROM workspace_invites WHERE workspace_id = $1
  `, [workspaceId])).rows;
  const work = (await db.query(`
    SELECT id, name, slug, subscription_state, retention_days,
      context_delivery_enabled, plan_override, plan_override_expires_at,
      plan_override_note, created_at
    FROM workspaces WHERE id = $1
  `, [workspaceId])).rows[0];
  await db.query(`
    INSERT INTO audit_events (
      id, workspace_id, actor_type, actor_id, action,
      target_type, target_id, metadata_json
    ) VALUES ($1, $2, 'user', $3, 'workspace.export', 'workspace', $4, '{}')
  `, [randomUUID(), workspaceId, userId, workspaceId]);
  return {
    format: "termyte-workspace-export",
    version: 1,
    exported_at: new Date().toISOString(),
    workspace: work,
    data,
  };
}

export async function setRetention(
  db: Database,
  userId: string,
  workspaceId: string,
  retentionDays: number,
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    await client.query(`
      UPDATE workspaces SET retention_days = $1 WHERE id = $2
    `, [retentionDays, workspaceId]);
    await client.query(`
      INSERT INTO jobs (id, workspace_id, kind, dedupe_key, payload_json, state)
      VALUES ($1, $2, 'enforce_retention', $3, $4, 'pending')
      ON CONFLICT (kind, dedupe_key) DO NOTHING
    `, [
      randomUUID(),
      workspaceId,
      `${workspaceId}:${new Date().toISOString().slice(0, 10)}`,
      { workspace_id: workspaceId },
    ]);
    await audit(client, workspaceId, userId, "workspace.retention.update", "workspace", workspaceId, {
      retention_days: retentionDays,
    });
    return { retention_days: retentionDays };
  });
}

export async function deleteSourceEvent(
  db: Database,
  userId: string,
  workspaceId: string,
  sourceEventId: string,
) {
  return transaction(db, async (client) => {
    await requireMembership(client, userId, workspaceId);
    const event = await client.query(`
      SELECT id FROM source_events WHERE id = $1 AND workspace_id = $2
      FOR UPDATE
    `, [sourceEventId, workspaceId]);
    if (!event.rows[0]) throw new NotFoundError();
    await client.query(`
      UPDATE context_items SET state = 'deleted', updated_at = now()
      WHERE workspace_id = $1 AND id IN (
        SELECT context_item_id FROM context_item_sources WHERE source_event_id = $2
      )
    `, [workspaceId, sourceEventId]);
    await audit(client, workspaceId, userId, "source_event.delete", "source_event", sourceEventId);
    await client.query(`DELETE FROM source_events WHERE id = $1`, [sourceEventId]);
    return { deleted: true };
  });
}

export async function requestWorkspaceDeletion(
  db: Database,
  userId: string,
  workspaceId: string,
  confirmationSlug: string,
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const workspace = (await client.query(`
      SELECT slug FROM workspaces WHERE id = $1 FOR UPDATE
    `, [workspaceId])).rows[0] as { slug: string } | undefined;
    if (!workspace) throw new NotFoundError();
    if (workspace.slug !== confirmationSlug) {
      throw new ConflictError("Workspace slug confirmation does not match");
    }
    await audit(client, workspaceId, userId, "workspace.delete.request", "workspace", workspaceId);
    await client.query(`
      UPDATE workspaces SET deletion_requested_at = COALESCE(deletion_requested_at, now())
      WHERE id = $1
    `, [workspaceId]);
    await client.query(`
      INSERT INTO jobs (id, workspace_id, kind, dedupe_key, payload_json, state)
      VALUES ($1, $2, 'delete_workspace', $3, $4, 'pending')
      ON CONFLICT (kind, dedupe_key) DO NOTHING
    `, [randomUUID(), workspaceId, workspaceId, { workspace_id: workspaceId }]);
    return { deletion_scheduled: true };
  });
}

export async function setContextDelivery(
  db: Database,
  userId: string,
  workspaceId: string,
  input: {
    target: "workspace" | "agent" | "work_thread";
    targetId: string;
    enabled: boolean;
  },
) {
  return transaction(db, async (client) => {
    await requireAdmin(client, userId, workspaceId);
    const table = input.target === "workspace"
      ? "workspaces"
      : input.target === "agent"
        ? "agent_identities"
        : "work_threads";
    if (input.target === "workspace" && input.targetId !== workspaceId) {
      throw new NotFoundError();
    }
    const ownershipColumn = input.target === "workspace" ? "id" : "workspace_id";
    const result = await client.query(`
      UPDATE ${table}
      SET context_delivery_enabled = $1
      WHERE id = $2 AND ${ownershipColumn} = $3
    `, [input.enabled, input.targetId, workspaceId]);
    if (result.rowCount !== 1) throw new NotFoundError();
    await audit(
      client,
      workspaceId,
      userId,
      "context_delivery.update",
      input.target,
      input.targetId,
      { enabled: input.enabled },
    );
    return { target: input.target, target_id: input.targetId, enabled: input.enabled };
  });
}

async function requireMembership(
  db: Database | pg.PoolClient,
  userId: string,
  workspaceId: string,
) {
  const result = await db.query(`
    SELECT m.role FROM workspace_memberships m
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL
      AND w.deletion_requested_at IS NULL
  `, [workspaceId, userId]);
  if (!result.rows[0]) throw new ForbiddenError();
  return result.rows[0] as { role: "owner" | "admin" | "member" };
}

async function requireAdmin(
  db: Database | pg.PoolClient,
  userId: string,
  workspaceId: string,
) {
  const membership = await requireMembership(db, userId, workspaceId);
  if (membership.role === "member") throw new ForbiddenError();
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
    ) VALUES ($1, $2, 'user', $3, $4, $5, $6, $7)
  `, [randomUUID(), workspaceId, userId, action, targetType, targetId, metadata]);
}
