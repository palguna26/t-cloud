import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { AgentPrincipal } from "./agent-auth.js";
import { createHash } from "node:crypto";
import type { AgentEvent, ResolveContextRequest, ResolveContextResponse, AcknowledgeReceiptRequest } from "termyte/protocol";
import type { ReportOutcomeRequest } from "termyte/protocol";

export async function storeAlphaEvents(db: Database, principal: AgentPrincipal, events: AgentEvent[]): Promise<{ accepted: string[]; existing: string[] }> {
  const accepted: string[] = [];
  const existing: string[] = [];
  await db.query("BEGIN");
  try {
    for (const event of events) {
      const repository = event.repository_key ?? null;
      const inserted = await db.query(`
        INSERT INTO alpha_source_records
          (id, workspace_id, provider, external_id, record_type, repository, branch, content, event_at)
        VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))
        ON CONFLICT (workspace_id, provider, external_id) DO NOTHING
      `, [randomUUID(), principal.workspaceId, event.event_id, event.event_type, repository, event.branch ?? null, event.content ?? JSON.stringify(event.metadata ?? {}), event.occurred_at]);
      (inserted.rowCount === 1 ? accepted : existing).push(event.event_id);
      const source = (await db.query<{ id: string; content: string; event_at: Date }>(`
        SELECT id, content, event_at FROM alpha_source_records
        WHERE workspace_id = $1 AND provider = 'agent' AND external_id = $2
      `, [principal.workspaceId, event.event_id])).rows[0];
      if (source) {
        await db.query(`
          INSERT INTO alpha_agent_sessions
            (id, workspace_id, external_session_id, agent, repository, branch, started_at, completed_at, completion_status)
          VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), $8, $9)
          ON CONFLICT (workspace_id, external_session_id) DO NOTHING
        `, [randomUUID(), principal.workspaceId, event.agent_session_id, event.source.platform, repository ?? "unknown", event.branch ?? null, event.occurred_at, event.event_type === "session_ended" ? new Date(event.occurred_at) : null, event.event_type === "session_ended" ? "pending" : "active"]);
        const memoryType = alphaMemoryType(event.event_type);
        if (memoryType) {
          const memoryId = randomUUID();
          await db.query(`
            INSERT INTO alpha_memories (id, workspace_id, memory_type, content, repository, branch, confidence, status, event_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
            ON CONFLICT DO NOTHING
          `, [memoryId, principal.workspaceId, memoryType, source.content, repository, event.branch ?? null, event.event_type === 'outcome' ? 0.95 : 0.75, source.event_at]);
          await db.query(`
            INSERT INTO alpha_memory_sources (memory_id, source_record_id, agent_session_id)
            SELECT $1, $2, id FROM alpha_agent_sessions
            WHERE workspace_id = $3 AND external_session_id = $4
              AND EXISTS (SELECT 1 FROM alpha_memories WHERE id = $1)
            ON CONFLICT DO NOTHING
          `, [memoryId, source.id, principal.workspaceId, event.agent_session_id]);
        }
      }
      await db.query(`
        INSERT INTO alpha_agent_sessions
          (id, workspace_id, external_session_id, agent, repository, branch, started_at, completed_at, completion_status)
        VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), $8, $9)
        ON CONFLICT (workspace_id, external_session_id) DO UPDATE SET
          branch = COALESCE(EXCLUDED.branch, alpha_agent_sessions.branch),
          completed_at = COALESCE(EXCLUDED.completed_at, alpha_agent_sessions.completed_at),
          completion_status = CASE WHEN EXCLUDED.completed_at IS NOT NULL THEN 'pending' ELSE alpha_agent_sessions.completion_status END
      `, [randomUUID(), principal.workspaceId, event.agent_session_id, event.source.platform, repository ?? "unknown", event.branch ?? null, event.occurred_at, event.event_type === "session_ended" ? new Date(event.occurred_at) : null, event.event_type === "session_ended" ? "pending" : "active"]);
    }
    await db.query("COMMIT");
    return { accepted, existing };
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}

function alphaMemoryType(eventType: string): "decision" | "requirement" | "problem" | "failed_attempt" | "progress" | "outcome" | "unfinished_work" | null {
  if (eventType === "outcome") return "outcome";
  if (eventType === "failure") return "failed_attempt";
  if (eventType === "user_prompt") return "requirement";
  if (eventType === "evidence" || eventType === "action" || eventType === "session_started") return "progress";
  return null;
}

export async function resolveAlphaContext(db: Database, principal: AgentPrincipal, input: ResolveContextRequest): Promise<ResolveContextResponse> {
  const references = input.explicit_references;
  const result = await db.query<{
    id: string; provider: "agent" | "slack" | "github"; record_type: string; content: string; repository: string | null; branch: string | null; source_url: string | null; event_at: Date;
  }>(`
    SELECT id, provider, record_type, content, repository, branch, source_url, event_at
    FROM alpha_source_records
    WHERE workspace_id = $1
      AND ($2::text IS NULL OR repository = $2)
      AND ($3::text IS NULL OR branch = $3)
      AND ($4::text[] = '{}' OR source_url = ANY($4::text[]) OR content ILIKE ANY (SELECT '%' || value || '%' FROM unnest($4::text[]) value))
    ORDER BY CASE WHEN branch = $3 AND $3 IS NOT NULL THEN 0 ELSE 1 END, event_at DESC
    LIMIT $5
  `, [principal.workspaceId, input.repository_key, input.branch ?? null, references, Math.min(20, input.cloud_token_budget / 40)]);
  if (result.rows.length === 0) return { schema_version: 3, state: "abstained", receipt_id: randomUUID(), code: "no_match", message: "No confident context match for this repository and branch." };
  const response: ResolveContextResponse = {
    schema_version: 3, state: "context", receipt_id: randomUUID(), task_mode: input.task_mode_hint ?? "general", omitted_count: 0, expires_at: Date.now() + 300_000,
    items: result.rows.map((row) => ({ item_id: row.id, type: row.record_type === "failure" ? "attempt" : "fact", text: row.content, status: "observed", confidence: row.branch === input.branch && input.branch ? 0.95 : 0.75, task_relevance: 80, company_relevance: 40, task_reason: "Matched repository and session context", company_reason: "Stored source record", source: { source_record_id: row.id, provider: row.provider, title: row.record_type, ...(row.source_url ? { url: row.source_url } : {}), occurred_at: row.event_at.getTime() } })),
  };
  await db.query(`INSERT INTO alpha_receipts (id, workspace_id, agent_identity_id, packet_json, expires_at) VALUES ($1,$2,$3,$4,to_timestamp($5 / 1000.0))`, [response.receipt_id, principal.workspaceId, principal.agentIdentityId, JSON.stringify(response), response.expires_at]);
  return response;
}

export async function acknowledgeAlphaReceipt(db: Database, principal: AgentPrincipal, receiptId: string, input: AcknowledgeReceiptRequest) {
  const receipt = (await db.query<{ packet_json: ResolveContextResponse; expires_at: Date; delivery_status: string | null }>(`SELECT packet_json, expires_at, delivery_status FROM alpha_receipts WHERE id=$1 AND workspace_id=$2 AND agent_identity_id=$3`, [receiptId, principal.workspaceId, principal.agentIdentityId])).rows[0];
  if (!receipt) throw new Error("Receipt not found");
  if (receipt.delivery_status) return { acknowledged: true as const, schema_version: 3 as const };
  if (receipt.expires_at.getTime() <= Date.now()) throw new Error("Receipt expired");
  if (input.delivery_status === "delivered") {
    const hash = createHash("sha256").update(input.final_packet, "utf8").digest("hex");
    if (hash !== input.final_packet_sha256 || input.final_packet !== JSON.stringify(receipt.packet_json)) throw new Error("Receipt packet hash mismatch");
  }
  await db.query(`UPDATE alpha_receipts SET delivery_status=$2, acknowledged_at=now(), idempotency_key=$3 WHERE id=$1 AND delivery_status IS NULL`, [receiptId, input.delivery_status, input.idempotency_key]);
  return { acknowledged: true as const, schema_version: 3 as const };
}

export async function storeAlphaOutcome(db: Database, principal: AgentPrincipal, input: ReportOutcomeRequest): Promise<void> {
  await db.query("BEGIN");
  try {
    let session = (await db.query<{ id: string; repository: string; branch: string | null }>(`
      SELECT id, repository, branch FROM alpha_agent_sessions
      WHERE workspace_id = $1 AND external_session_id = $2
      FOR UPDATE
    `, [principal.workspaceId, input.agent_session_id])).rows[0];
    if (!session) {
      session = { id: randomUUID(), repository: "unknown", branch: null };
      await db.query(`INSERT INTO alpha_agent_sessions (id, workspace_id, external_session_id, agent, repository, started_at) VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (workspace_id, external_session_id) DO NOTHING`, [session.id, principal.workspaceId, input.agent_session_id, principal.platform, session.repository]);
    }
    if (session) {
      await db.query(`UPDATE alpha_agent_sessions SET completed_at = to_timestamp($2 / 1000.0), completion_status = $3::text, summary_json = jsonb_build_object('work_performed', jsonb_build_array($4::text), 'decisions', '[]'::jsonb, 'changes', '[]'::jsonb, 'problems', '[]'::jsonb, 'failed_attempts', '[]'::jsonb, 'current_status', $3::text, 'unfinished_work', '[]'::jsonb, 'next_steps', '[]'::jsonb, 'references', '[]'::jsonb) WHERE id = $1`, [session.id, input.reported_at, input.status, input.summary]);
      await db.query(`INSERT INTO alpha_source_records (id, workspace_id, provider, external_id, record_type, repository, branch, content, event_at) VALUES ($1, $2, 'agent', $3, 'outcome', $4, $5, $6, to_timestamp($7 / 1000.0)) ON CONFLICT (workspace_id, provider, external_id) DO NOTHING`, [randomUUID(), principal.workspaceId, `outcome:${input.idempotency_key}`, session.repository, session.branch, input.summary, input.reported_at]);
    }
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}
