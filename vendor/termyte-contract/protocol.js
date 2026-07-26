import { z } from "zod";
export const TERMYTE_PROTOCOL_VERSION = 2;
const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(100_000);
const shortText = z.string().trim().min(1).max(500);
const timestamp = z.number().int().nonnegative();
const metadata = z.record(z.string(), z.unknown());
const taskMode = z.enum([
    "implement",
    "investigate",
    "review",
    "verify",
    "continue",
    "general",
]);
const receiptType = z.enum([
    "initial",
    "delta",
    "full_refresh",
    "cached_fallback",
]);
const deliveryStatus = z.enum([
    "pending",
    "delivered",
    "failed",
    "expired",
]);
const versioned = {
    schema_version: z.literal(TERMYTE_PROTOCOL_VERSION),
};
export const AgentScopeSchema = z.enum([
    "events:write",
    "context:read",
    "outcomes:write",
    "handoffs:create",
    "handoffs:claim",
]);
export const AgentPlatformSchema = z.enum([
    "claude-code",
    "codex",
    "opencode",
]);
export const WorkThreadStatusSchema = z.enum([
    "proposed",
    "active",
    "blocked",
    "in_review",
    "completed",
    "cancelled",
    "archived",
]);
export const ContextItemTypeSchema = z.enum([
    "objective",
    "current_state",
    "decision",
    "constraint",
    "observation",
    "attempt",
    "failure",
    "blocker",
    "evidence",
    "expected_result",
    "next_action",
    "outcome",
]);
export const AgentEventTypeSchema = z.enum([
    "session_started",
    "user_prompt",
    "observation",
    "decision",
    "constraint",
    "action",
    "attempt",
    "failure",
    "evidence",
    "status_changed",
    "outcome",
    "session_ended",
]);
export const AgentEventSchema = z.object({
    event_id: id,
    event_type: AgentEventTypeSchema,
    agent_session_id: id,
    work_thread_id: id.nullable().optional(),
    occurred_at: timestamp,
    source: z.object({
        platform: AgentPlatformSchema,
        external_id: id.optional(),
    }).strict(),
    content: text.optional(),
    files: z.array(shortText).max(1_000).optional(),
    metadata: metadata.optional(),
}).strict();
export const EventBatchRequestSchema = z.object({
    ...versioned,
    events: z.array(AgentEventSchema).min(1).max(100),
}).strict();
export const EventBatchResponseSchema = z.object({
    ...versioned,
    accepted_event_ids: z.array(id),
    existing_event_ids: z.array(id),
}).strict();
export const CreateWorkRequestSchema = z.object({
    ...versioned,
    title: shortText,
    objective: text,
    initial_status: z.enum(["proposed", "active"]).optional(),
    repository_key: shortText.optional(),
    agent_session_id: id,
    idempotency_key: id,
}).strict();
export const WorkThreadSchema = z.object({
    id,
    title: shortText,
    objective: text,
    status: WorkThreadStatusSchema,
    version: z.number().int().positive(),
    repository_key: shortText.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
}).strict();
export const CreateWorkResponseSchema = z.object({
    ...versioned,
    work_thread: WorkThreadSchema,
}).strict();
export const CreateHandoffRequestSchema = z.object({
    ...versioned,
    work_thread_id: id,
    to_agent_identity_id: id,
    instruction: text,
    expires_at: timestamp.optional(),
    idempotency_key: id,
}).strict();
export const HandoffSchema = z.object({
    id,
    work_thread_id: id,
    from_agent_identity_id: id,
    to_agent_identity_id: id,
    instruction: text,
    status: z.enum(["ready", "claimed", "completed", "cancelled", "expired"]),
    created_at: timestamp,
    claimed_at: timestamp.nullable(),
    completed_at: timestamp.nullable(),
    expires_at: timestamp.nullable(),
}).strict();
export const CreateHandoffResponseSchema = z.object({
    ...versioned,
    handoff: HandoffSchema,
}).strict();
export const ClaimHandoffRequestSchema = z.object({
    ...versioned,
    agent_session_id: id,
    idempotency_key: id,
}).strict();
export const ClaimHandoffResponseSchema = z.object({
    ...versioned,
    handoff: HandoffSchema,
    work_thread: WorkThreadSchema,
}).strict();
export const ResolveContextRequestSchema = z.object({
    ...versioned,
    request_text: text,
    agent_session_id: id,
    work_thread_id: id.optional(),
    handoff_id: id.optional(),
    selection_token: id.optional(),
    task_mode_hint: taskMode.optional(),
    repository_key: shortText.optional(),
    branch: shortText.optional(),
    recent_work_thread_ids: z.array(id).max(20).optional(),
    token_budget: z.number().int().min(256).max(8_000).default(2_000),
    idempotency_key: id,
}).strict();
export const ContextSourceSchema = z.object({
    context_item_id: id,
    type: ContextItemTypeSchema,
    source_event_ids: z.array(id).min(1),
    inclusion_reason: shortText,
}).strict();
export const ResolvedContextResponseSchema = z.object({
    ...versioned,
    state: z.literal("resolved"),
    receipt_type: receiptType,
    task_mode: taskMode,
    work_thread_id: id,
    work_thread_version: z.number().int().positive(),
    receipt_id: id,
    briefing: text,
    estimated_tokens: z.number().int().nonnegative(),
    sources: z.array(ContextSourceSchema),
    expires_at: timestamp,
}).strict();
export const ClarificationContextResponseSchema = z.object({
    ...versioned,
    state: z.literal("clarification_required"),
    question: shortText,
    candidates: z.array(z.object({
        selection_token: id,
        label: shortText,
    }).strict()).min(2).max(3),
}).strict();
export const NotFoundContextResponseSchema = z.object({
    ...versioned,
    state: z.literal("not_found"),
    message: shortText,
}).strict();
export const ResolveContextResponseSchema = z.discriminatedUnion("state", [
    ResolvedContextResponseSchema,
    ClarificationContextResponseSchema,
    NotFoundContextResponseSchema,
]);
const AcknowledgeDeliveredReceiptRequestSchema = z.object({
    ...versioned,
    delivery_status: z.literal("delivered"),
    delivered_at: timestamp,
    idempotency_key: id,
}).strict();
const AcknowledgeFailedReceiptRequestSchema = z.object({
    ...versioned,
    delivery_status: z.literal("failed"),
    failure_code: shortText,
    idempotency_key: id,
}).strict();
export const AcknowledgeReceiptRequestSchema = z.discriminatedUnion("delivery_status", [
    AcknowledgeDeliveredReceiptRequestSchema,
    AcknowledgeFailedReceiptRequestSchema,
]);
export const AcknowledgeReceiptResponseSchema = z.object({
    ...versioned,
    acknowledged: z.literal(true),
}).strict();
export const RefreshContextRequestSchema = z.object({
    ...versioned,
    previous_receipt_id: id,
    request_text: text,
    agent_session_id: id,
    task_mode_hint: taskMode.optional(),
    token_budget: z.number().int().min(256).max(8_000).default(2_000),
    idempotency_key: id,
}).strict();
export const PendingRefreshContextResponseSchema = z.object({
    ...versioned,
    state: z.literal("pending"),
    message: shortText,
    retry_after_ms: z.number().int().positive(),
}).strict();
export const UnchangedRefreshContextResponseSchema = z.object({
    ...versioned,
    state: z.literal("unchanged"),
    work_thread_id: id,
    work_thread_version: z.number().int().positive(),
    receipt_id: id,
    expires_at: timestamp,
}).strict();
export const BindingLostContextResponseSchema = z.object({
    ...versioned,
    state: z.literal("binding_lost"),
    message: shortText,
}).strict();
export const RefreshContextResponseSchema = z.discriminatedUnion("state", [
    ResolvedContextResponseSchema,
    PendingRefreshContextResponseSchema,
    UnchangedRefreshContextResponseSchema,
    BindingLostContextResponseSchema,
]);
export const ReportOutcomeRequestSchema = z.object({
    ...versioned,
    work_thread_id: id,
    receipt_id: id.optional(),
    agent_session_id: id,
    status: z.enum(["succeeded", "failed", "partial", "blocked", "abandoned"]),
    summary: text,
    evidence: z.array(z.object({
        kind: z.enum(["command", "test", "build", "diff", "file", "human_feedback", "agent_statement"]),
        content: text,
        metadata: metadata.optional(),
    }).strict()).max(100).default([]),
    reported_at: timestamp,
    idempotency_key: id,
}).strict();
export const ReportOutcomeResponseSchema = z.object({
    ...versioned,
    outcome_id: id,
    work_thread_version: z.number().int().positive(),
}).strict();
export const ProtocolErrorSchema = z.object({
    ...versioned,
    code: z.enum([
        "INVALID_ARGUMENT",
        "UNAUTHENTICATED",
        "FORBIDDEN",
        "NOT_FOUND",
        "CONFLICT",
        "UNSUPPORTED_VERSION",
        "RATE_LIMITED",
        "INTERNAL",
    ]),
    message: shortText,
    request_id: id,
    retryable: z.boolean(),
    field: shortText.optional(),
}).strict();
export const DeviceAuthorizationStartRequestSchema = z.object({
    ...versioned,
    device_name: shortText,
    platform: AgentPlatformSchema,
    requested_scopes: z.array(AgentScopeSchema).min(1).max(5),
}).strict();
export const DeviceAuthorizationStartResponseSchema = z.object({
    ...versioned,
    device_code: id,
    user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
    verification_uri: z.string().url(),
    verification_uri_complete: z.string().url(),
    expires_in: z.number().int().positive(),
    interval: z.number().int().min(1).max(30),
}).strict();
export const DeviceAuthorizationPollRequestSchema = z.object({
    ...versioned,
    device_code: id,
}).strict();
export const DeviceAuthorizationPollResponseSchema = z.discriminatedUnion("state", [
    z.object({
        ...versioned,
        state: z.literal("pending"),
        interval: z.number().int().min(1).max(30),
    }).strict(),
    z.object({
        ...versioned,
        state: z.literal("authorized"),
        credential: id,
        workspace_id: id,
        agent_identity_id: id,
        scopes: z.array(AgentScopeSchema),
    }).strict(),
]);
export class UnsupportedProtocolVersionError extends Error {
    received;
    constructor(received) {
        super(`Unsupported Termyte protocol version: ${String(received)}`);
        this.name = "UnsupportedProtocolVersionError";
        this.received = received;
    }
}
export function parseProtocol(schema, input) {
    const received = typeof input === "object" && input !== null
        ? input["schema_version"]
        : undefined;
    if (received !== TERMYTE_PROTOCOL_VERSION) {
        throw new UnsupportedProtocolVersionError(received);
    }
    return schema.parse(input);
}
