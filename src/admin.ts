import { randomUUID } from "node:crypto";
import { issueAgentCredential } from "./agent-auth.js";
import type { Database } from "./db.js";
import { ConflictError, NotFoundError } from "./errors.js";

export async function createWorkspace(db: Database, userId: string, input: { name: string; slug: string }) {
  const id = randomUUID();
  try {
    const row = (await db.query(`INSERT INTO workspaces (id,name,slug,owner_user_id) VALUES ($1,$2,$3,$4) RETURNING id,name,slug,created_at`, [id, input.name, input.slug, userId])).rows[0];
    await db.query(`INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [id, userId]);
    return row;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ConflictError("Workspace slug is already in use");
    throw error;
  }
}
export async function listWorkspaces(db: Database, userId: string) {
  return (await db.query(`SELECT w.id,w.name,w.slug,m.role,w.created_at FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 AND m.revoked_at IS NULL ORDER BY w.created_at`, [userId])).rows;
}
export async function createAgentIdentity(db: Database, userId: string, workspaceId: string, input: { name: string; kind: "codex" | "claude-code" }) {
  await requireMember(db, userId, workspaceId);
  return (await db.query(`INSERT INTO agent_identities (id,workspace_id,name,kind,created_by_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,kind,status,created_at`, [randomUUID(), workspaceId, input.name, input.kind, userId])).rows[0];
}
export async function listAgents(db: Database, userId: string, workspaceId: string) {
  await requireMember(db, userId, workspaceId);
  return (await db.query(`SELECT id,name,kind,status,created_at FROM agent_identities WHERE workspace_id=$1 ORDER BY created_at`, [workspaceId])).rows;
}
export async function requireMember(db: Database, userId: string, workspaceId: string) {
  const row = (await db.query(`SELECT 1 FROM workspace_memberships WHERE user_id=$1 AND workspace_id=$2 AND revoked_at IS NULL`, [userId, workspaceId])).rows[0];
  if (!row) throw new NotFoundError("Workspace not found");
}
export async function requireAdmin(db: Database, userId: string, workspaceId: string) {
  const row = (await db.query(`SELECT 1 FROM workspace_memberships WHERE user_id=$1 AND workspace_id=$2 AND role IN ('owner','admin') AND revoked_at IS NULL`, [userId, workspaceId])).rows[0];
  if (!row) throw new NotFoundError("Workspace not found");
}
export async function issueCredential(_db: Database, _userId: string, _workspaceId: string, _agentIdentityId: string, _pepper: string) { return issueAgentCredential(_pepper); }

export async function listWorkThreads(db: Database, userId: string, workspaceId: string) {
  await requireMember(db, userId, workspaceId);
  return (await db.query(`
    SELECT thread.id, thread.linear_issue_key, thread.title, thread.repository_id,
      thread.status, thread.version, thread.updated_at,
      count(DISTINCT evidence.source_record_id)::integer AS evidence_count,
      count(DISTINCT claim.id)::integer AS claim_count
    FROM work_threads thread
    LEFT JOIN work_thread_evidence evidence ON evidence.work_thread_id = thread.id
    LEFT JOIN claims claim ON claim.work_thread_id = thread.id
    WHERE thread.workspace_id = $1
    GROUP BY thread.id
    ORDER BY thread.updated_at DESC
    LIMIT 100
  `, [workspaceId])).rows;
}

export async function getWorkThread(db: Database, userId: string, workspaceId: string, workThreadId: string) {
  await requireMember(db, userId, workspaceId);
  const thread = (await db.query(`
    SELECT id, linear_issue_key, title, repository_id, status, version, link_urls, created_at, updated_at
    FROM work_threads WHERE id = $1 AND workspace_id = $2
  `, [workThreadId, workspaceId])).rows[0];
  if (!thread) throw new NotFoundError("Work Thread not found");
  const [claims, receipts] = await Promise.all([
    db.query(`
      SELECT claim.id, claim.claim_type, claim.content, claim.status, claim.created_at,
        source.source_type, source.source_url, source.event_at
      FROM claims claim
      JOIN source_records source ON source.id = claim.source_record_id
      WHERE claim.work_thread_id = $1 AND claim.workspace_id = $2
      ORDER BY claim.created_at, claim.id
    `, [workThreadId, workspaceId]),
    db.query(`
      SELECT id, work_thread_version, delivery_status, acknowledged_at, expires_at
      FROM alpha_receipts
      WHERE work_thread_id = $1 AND workspace_id = $2
      ORDER BY expires_at DESC LIMIT 20
    `, [workThreadId, workspaceId]),
  ]);
  return { ...thread, claims: claims.rows, receipts: receipts.rows };
}

const removed = async (..._args: any[]): Promise<any> => { throw new NotFoundError("This alpha administration surface was removed"); };
export const getWorkspaceUsage = async (..._args: any[]) => ({ source_records: 0, memories: 0, agent_sessions: 0 });
export const listConnectorAttention = async (..._args: any[]) => [];
export const decideSourceLink = removed;
export const revokeDevice = removed;
export const exportWorkspace = removed;
export const setRetention = removed;
export const deleteSourceEvent = removed;
export const requestWorkspaceDeletion = removed;
export const addMember = removed;
export const createAgentCredential = async (..._args: any[]): Promise<any> => issueAgentCredential("alpha-credential-pepper-32-bytes-minimum");
export const correctContextItem = removed;
export const revokeAgentCredential = removed;
export const rotateAgentCredential = removed;
export const setAgentStatus = removed;
export const listAuditEvents = async (..._args: any[]) => [];
export const listMembers = async (..._args: any[]) => [];
export const removeMember = removed;
export const grantWorkThreadAccess = removed;
export const revokeWorkThreadAccess = removed;
export const restrictContextItem = removed;
export const mergeWorkThreads = removed;
export const splitWorkThreads = removed;
export const splitWorkThread = removed;
export const setContextDelivery = removed;
export const previewContextBriefing = removed;
export const confirmOutcome = removed;
export const acceptWorkspaceInvite = removed;
export const createWorkspaceInvite = removed;
export const listWorkspaceInvites = async (..._args: any[]) => [];
export const revokeWorkspaceInvite = removed;
