import { z } from "zod";
export const TERMYTE_PROTOCOL_VERSION = 3;
const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(100_000);
const shortText = z.string().trim().min(1).max(2_000);
const timestamp = z.number().int().nonnegative();
const versioned = { schema_version: z.literal(TERMYTE_PROTOCOL_VERSION) };
export const AgentPlatformSchema = z.enum(["codex", "claude-code"]);
export const TaskModeSchema = z.enum(["implement", "investigate", "review", "verify", "continue", "general"]);
export const TrustStatusSchema = z.enum(["observed", "inferred", "verified", "proposed", "conflicting", "stale"]);
export const SourceProviderSchema = z.enum(["local", "github", "slack", "agent"]);
export const DeliveryStatusSchema = z.enum(["delivered", "failed"]);
export const AbstentionCodeSchema = z.enum(["low_confidence", "no_match", "no_authorized_sources", "no_indexed_sources"]);
export const AgentEventTypeSchema = z.enum(["session_started", "user_prompt", "observation", "decision", "constraint", "action", "attempt", "failure", "evidence", "status_changed", "outcome", "session_ended"]);
export const AgentScopeSchema = z.enum(["events:write", "context:read", "outcomes:write"]);
export const AgentEventSchema = z.object({
    event_id: id, event_type: AgentEventTypeSchema, agent_session_id: id, occurred_at: timestamp,
    source: z.object({ platform: AgentPlatformSchema, external_id: id.optional() }).strict(),
    repository_key: shortText.optional(), branch: shortText.optional(), receipt_id: id.optional(),
    content: text.optional(), files: z.array(shortText).max(200).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const EventBatchRequestSchema = z.object({ ...versioned, events: z.array(AgentEventSchema).min(1).max(100) }).strict();
export const EventBatchResponseSchema = z.object({ ...versioned, accepted_event_ids: z.array(id), existing_event_ids: z.array(id) }).strict();
export const ResolveContextRequestSchema = z.object({
    ...versioned, request_text: text, agent_session_id: id, repository_key: shortText,
    branch: shortText.optional(), changed_files: z.array(shortText).max(200), recent_files: z.array(shortText).max(200),
    explicit_references: z.array(shortText).max(50), task_mode_hint: TaskModeSchema.optional(), previous_receipt_id: id.optional(),
    cloud_token_budget: z.number().int().min(256).max(1600), idempotency_key: id,
}).strict();
const ContextItemSchema = z.object({
    item_id: id, type: z.enum(["fact", "decision", "constraint", "requirement", "attempt", "discovery", "open_question", "outcome", "evidence"]),
    text, status: TrustStatusSchema, confidence: z.number().min(0).max(1), task_relevance: z.number().int().min(0).max(100), company_relevance: z.number().int().min(0).max(100),
    task_reason: shortText, company_reason: shortText, source: z.object({ source_record_id: id, provider: z.enum(["github", "slack", "agent"]), title: shortText, url: z.string().url().optional(), author: shortText.optional(), occurred_at: timestamp }).strict(),
}).strict();
export const ResolvedContextResponseSchema = z.object({ ...versioned, state: z.literal("context"), receipt_id: id, task_mode: TaskModeSchema, items: z.array(ContextItemSchema), omitted_count: z.number().int().nonnegative(), expires_at: timestamp }).strict();
export const AbstainedContextResponseSchema = z.object({ ...versioned, state: z.literal("abstained"), receipt_id: id, code: AbstentionCodeSchema, message: shortText }).strict();
export const ResolveContextResponseSchema = z.discriminatedUnion("state", [ResolvedContextResponseSchema, AbstainedContextResponseSchema]);
export const AcknowledgeReceiptRequestSchema = z.discriminatedUnion("delivery_status", [
    z.object({ ...versioned, delivery_status: z.literal("delivered"), delivered_at: timestamp, final_packet: text, final_packet_sha256: z.string().regex(/^[0-9a-f]{64}$/), local_item_count: z.number().int().nonnegative(), cloud_item_ids: z.array(id), idempotency_key: id }).strict(),
    z.object({ ...versioned, delivery_status: z.literal("failed"), failure_code: shortText, idempotency_key: id }).strict(),
]);
export const AcknowledgeReceiptResponseSchema = z.object({ ...versioned, acknowledged: z.literal(true) }).strict();
export const ReportOutcomeRequestSchema = z.object({ ...versioned, agent_session_id: id, receipt_id: id.optional(), status: z.enum(["succeeded", "failed", "partial", "blocked", "abandoned"]), summary: text, evidence: z.array(z.object({ kind: z.enum(["command", "test", "build", "diff", "file", "human_feedback", "agent_statement"]), content: text, metadata: z.record(z.string(), z.unknown()).optional() }).strict()).max(100), reported_at: timestamp, idempotency_key: id }).strict();
export const ReportOutcomeResponseSchema = z.object({ ...versioned, outcome_id: id }).strict();
export const ProtocolErrorSchema = z.object({ ...versioned, code: z.enum(["INVALID_ARGUMENT", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "UNSUPPORTED_VERSION", "RATE_LIMITED", "INTERNAL"]), message: shortText, request_id: id, retryable: z.boolean(), field: shortText.optional() }).strict();
export const DeviceAuthorizationStartRequestSchema = z.object({ ...versioned, device_name: shortText, platform: AgentPlatformSchema, requested_scopes: z.array(AgentScopeSchema).min(1).max(3) }).strict();
export const DeviceAuthorizationStartResponseSchema = z.object({ ...versioned, device_code: id, user_code: z.string(), verification_uri: z.string().url(), verification_uri_complete: z.string().url(), expires_in: z.number().int().positive(), interval: z.number().int().positive() }).strict();
export const DeviceAuthorizationPollResponseSchema = z.discriminatedUnion("state", [z.object({ ...versioned, state: z.literal("pending"), interval: z.number().int().positive() }).strict(), z.object({ ...versioned, state: z.literal("authorized"), credential: id, workspace_id: id, agent_identity_id: id, scopes: z.array(AgentScopeSchema) }).strict()]);
export class UnsupportedProtocolVersionError extends Error {
    received;
    constructor(received) {
        super(`Unsupported Termyte protocol version: ${String(received)}`);
        this.received = received;
        this.name = "UnsupportedProtocolVersionError";
    }
}
export function parseProtocol(schema, input) { const received = input && typeof input === "object" ? input.schema_version : undefined; if (received !== TERMYTE_PROTOCOL_VERSION)
    throw new UnsupportedProtocolVersionError(received); return schema.parse(input); }
export const RefreshContextResponseSchema = z.record(z.string(), z.unknown());
