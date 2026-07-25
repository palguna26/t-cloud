import { z } from "zod";
export declare const TERMYTE_PROTOCOL_VERSION: 1;
export declare const AgentScopeSchema: z.ZodEnum<{
    "events:write": "events:write";
    "context:read": "context:read";
    "outcomes:write": "outcomes:write";
    "handoffs:create": "handoffs:create";
    "handoffs:claim": "handoffs:claim";
}>;
export declare const AgentPlatformSchema: z.ZodEnum<{
    "claude-code": "claude-code";
    codex: "codex";
    opencode: "opencode";
}>;
export declare const WorkThreadStatusSchema: z.ZodEnum<{
    proposed: "proposed";
    active: "active";
    blocked: "blocked";
    in_review: "in_review";
    completed: "completed";
    cancelled: "cancelled";
    archived: "archived";
}>;
export declare const ContextItemTypeSchema: z.ZodEnum<{
    objective: "objective";
    current_state: "current_state";
    decision: "decision";
    constraint: "constraint";
    observation: "observation";
    attempt: "attempt";
    failure: "failure";
    blocker: "blocker";
    evidence: "evidence";
    expected_result: "expected_result";
    next_action: "next_action";
    outcome: "outcome";
}>;
export declare const AgentEventTypeSchema: z.ZodEnum<{
    decision: "decision";
    constraint: "constraint";
    observation: "observation";
    attempt: "attempt";
    failure: "failure";
    evidence: "evidence";
    outcome: "outcome";
    session_started: "session_started";
    user_prompt: "user_prompt";
    action: "action";
    status_changed: "status_changed";
    session_ended: "session_ended";
}>;
export declare const AgentEventSchema: z.ZodObject<{
    event_id: z.ZodString;
    event_type: z.ZodEnum<{
        decision: "decision";
        constraint: "constraint";
        observation: "observation";
        attempt: "attempt";
        failure: "failure";
        evidence: "evidence";
        outcome: "outcome";
        session_started: "session_started";
        user_prompt: "user_prompt";
        action: "action";
        status_changed: "status_changed";
        session_ended: "session_ended";
    }>;
    agent_session_id: z.ZodString;
    work_thread_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    occurred_at: z.ZodNumber;
    source: z.ZodObject<{
        platform: z.ZodEnum<{
            "claude-code": "claude-code";
            codex: "codex";
            opencode: "opencode";
        }>;
        external_id: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    content: z.ZodOptional<z.ZodString>;
    files: z.ZodOptional<z.ZodArray<z.ZodString>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strict>;
export declare const EventBatchRequestSchema: z.ZodObject<{
    events: z.ZodArray<z.ZodObject<{
        event_id: z.ZodString;
        event_type: z.ZodEnum<{
            decision: "decision";
            constraint: "constraint";
            observation: "observation";
            attempt: "attempt";
            failure: "failure";
            evidence: "evidence";
            outcome: "outcome";
            session_started: "session_started";
            user_prompt: "user_prompt";
            action: "action";
            status_changed: "status_changed";
            session_ended: "session_ended";
        }>;
        agent_session_id: z.ZodString;
        work_thread_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        occurred_at: z.ZodNumber;
        source: z.ZodObject<{
            platform: z.ZodEnum<{
                "claude-code": "claude-code";
                codex: "codex";
                opencode: "opencode";
            }>;
            external_id: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        content: z.ZodOptional<z.ZodString>;
        files: z.ZodOptional<z.ZodArray<z.ZodString>>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strict>>;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const EventBatchResponseSchema: z.ZodObject<{
    accepted_event_ids: z.ZodArray<z.ZodString>;
    existing_event_ids: z.ZodArray<z.ZodString>;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const CreateWorkRequestSchema: z.ZodObject<{
    title: z.ZodString;
    objective: z.ZodString;
    initial_status: z.ZodOptional<z.ZodEnum<{
        proposed: "proposed";
        active: "active";
    }>>;
    repository_key: z.ZodOptional<z.ZodString>;
    agent_session_id: z.ZodString;
    idempotency_key: z.ZodString;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const WorkThreadSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    objective: z.ZodString;
    status: z.ZodEnum<{
        proposed: "proposed";
        active: "active";
        blocked: "blocked";
        in_review: "in_review";
        completed: "completed";
        cancelled: "cancelled";
        archived: "archived";
    }>;
    version: z.ZodNumber;
    repository_key: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNumber;
    updated_at: z.ZodNumber;
}, z.core.$strict>;
export declare const CreateWorkResponseSchema: z.ZodObject<{
    work_thread: z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        objective: z.ZodString;
        status: z.ZodEnum<{
            proposed: "proposed";
            active: "active";
            blocked: "blocked";
            in_review: "in_review";
            completed: "completed";
            cancelled: "cancelled";
            archived: "archived";
        }>;
        version: z.ZodNumber;
        repository_key: z.ZodNullable<z.ZodString>;
        created_at: z.ZodNumber;
        updated_at: z.ZodNumber;
    }, z.core.$strict>;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const CreateHandoffRequestSchema: z.ZodObject<{
    work_thread_id: z.ZodString;
    to_agent_identity_id: z.ZodString;
    instruction: z.ZodString;
    expires_at: z.ZodOptional<z.ZodNumber>;
    idempotency_key: z.ZodString;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const HandoffSchema: z.ZodObject<{
    id: z.ZodString;
    work_thread_id: z.ZodString;
    from_agent_identity_id: z.ZodString;
    to_agent_identity_id: z.ZodString;
    instruction: z.ZodString;
    status: z.ZodEnum<{
        completed: "completed";
        cancelled: "cancelled";
        ready: "ready";
        claimed: "claimed";
        expired: "expired";
    }>;
    created_at: z.ZodNumber;
    claimed_at: z.ZodNullable<z.ZodNumber>;
    completed_at: z.ZodNullable<z.ZodNumber>;
    expires_at: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export declare const CreateHandoffResponseSchema: z.ZodObject<{
    handoff: z.ZodObject<{
        id: z.ZodString;
        work_thread_id: z.ZodString;
        from_agent_identity_id: z.ZodString;
        to_agent_identity_id: z.ZodString;
        instruction: z.ZodString;
        status: z.ZodEnum<{
            completed: "completed";
            cancelled: "cancelled";
            ready: "ready";
            claimed: "claimed";
            expired: "expired";
        }>;
        created_at: z.ZodNumber;
        claimed_at: z.ZodNullable<z.ZodNumber>;
        completed_at: z.ZodNullable<z.ZodNumber>;
        expires_at: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const ClaimHandoffRequestSchema: z.ZodObject<{
    agent_session_id: z.ZodString;
    idempotency_key: z.ZodString;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const ClaimHandoffResponseSchema: z.ZodObject<{
    handoff: z.ZodObject<{
        id: z.ZodString;
        work_thread_id: z.ZodString;
        from_agent_identity_id: z.ZodString;
        to_agent_identity_id: z.ZodString;
        instruction: z.ZodString;
        status: z.ZodEnum<{
            completed: "completed";
            cancelled: "cancelled";
            ready: "ready";
            claimed: "claimed";
            expired: "expired";
        }>;
        created_at: z.ZodNumber;
        claimed_at: z.ZodNullable<z.ZodNumber>;
        completed_at: z.ZodNullable<z.ZodNumber>;
        expires_at: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    work_thread: z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        objective: z.ZodString;
        status: z.ZodEnum<{
            proposed: "proposed";
            active: "active";
            blocked: "blocked";
            in_review: "in_review";
            completed: "completed";
            cancelled: "cancelled";
            archived: "archived";
        }>;
        version: z.ZodNumber;
        repository_key: z.ZodNullable<z.ZodString>;
        created_at: z.ZodNumber;
        updated_at: z.ZodNumber;
    }, z.core.$strict>;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const ResolveContextRequestSchema: z.ZodObject<{
    request_text: z.ZodString;
    agent_session_id: z.ZodString;
    work_thread_id: z.ZodOptional<z.ZodString>;
    handoff_id: z.ZodOptional<z.ZodString>;
    repository_key: z.ZodOptional<z.ZodString>;
    branch: z.ZodOptional<z.ZodString>;
    recent_work_thread_ids: z.ZodOptional<z.ZodArray<z.ZodString>>;
    token_budget: z.ZodDefault<z.ZodNumber>;
    idempotency_key: z.ZodString;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const ContextSourceSchema: z.ZodObject<{
    context_item_id: z.ZodString;
    type: z.ZodEnum<{
        objective: "objective";
        current_state: "current_state";
        decision: "decision";
        constraint: "constraint";
        observation: "observation";
        attempt: "attempt";
        failure: "failure";
        blocker: "blocker";
        evidence: "evidence";
        expected_result: "expected_result";
        next_action: "next_action";
        outcome: "outcome";
    }>;
    source_event_ids: z.ZodArray<z.ZodString>;
    inclusion_reason: z.ZodString;
}, z.core.$strict>;
export declare const ResolvedContextResponseSchema: z.ZodObject<{
    state: z.ZodLiteral<"resolved">;
    work_thread_id: z.ZodString;
    work_thread_version: z.ZodNumber;
    receipt_id: z.ZodString;
    briefing: z.ZodString;
    estimated_tokens: z.ZodNumber;
    sources: z.ZodArray<z.ZodObject<{
        context_item_id: z.ZodString;
        type: z.ZodEnum<{
            objective: "objective";
            current_state: "current_state";
            decision: "decision";
            constraint: "constraint";
            observation: "observation";
            attempt: "attempt";
            failure: "failure";
            blocker: "blocker";
            evidence: "evidence";
            expected_result: "expected_result";
            next_action: "next_action";
            outcome: "outcome";
        }>;
        source_event_ids: z.ZodArray<z.ZodString>;
        inclusion_reason: z.ZodString;
    }, z.core.$strict>>;
    expires_at: z.ZodNumber;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const ClarificationContextResponseSchema: z.ZodObject<{
    state: z.ZodLiteral<"clarification_required">;
    question: z.ZodString;
    candidates: z.ZodArray<z.ZodObject<{
        work_thread_id: z.ZodString;
        label: z.ZodString;
    }, z.core.$strict>>;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const NotFoundContextResponseSchema: z.ZodObject<{
    state: z.ZodLiteral<"not_found">;
    message: z.ZodString;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const ResolveContextResponseSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    state: z.ZodLiteral<"resolved">;
    work_thread_id: z.ZodString;
    work_thread_version: z.ZodNumber;
    receipt_id: z.ZodString;
    briefing: z.ZodString;
    estimated_tokens: z.ZodNumber;
    sources: z.ZodArray<z.ZodObject<{
        context_item_id: z.ZodString;
        type: z.ZodEnum<{
            objective: "objective";
            current_state: "current_state";
            decision: "decision";
            constraint: "constraint";
            observation: "observation";
            attempt: "attempt";
            failure: "failure";
            blocker: "blocker";
            evidence: "evidence";
            expected_result: "expected_result";
            next_action: "next_action";
            outcome: "outcome";
        }>;
        source_event_ids: z.ZodArray<z.ZodString>;
        inclusion_reason: z.ZodString;
    }, z.core.$strict>>;
    expires_at: z.ZodNumber;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>, z.ZodObject<{
    state: z.ZodLiteral<"clarification_required">;
    question: z.ZodString;
    candidates: z.ZodArray<z.ZodObject<{
        work_thread_id: z.ZodString;
        label: z.ZodString;
    }, z.core.$strict>>;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>, z.ZodObject<{
    state: z.ZodLiteral<"not_found">;
    message: z.ZodString;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>], "state">;
export declare const AcknowledgeReceiptRequestSchema: z.ZodObject<{
    delivered_at: z.ZodNumber;
    idempotency_key: z.ZodString;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const AcknowledgeReceiptResponseSchema: z.ZodObject<{
    acknowledged: z.ZodLiteral<true>;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const ReportOutcomeRequestSchema: z.ZodObject<{
    work_thread_id: z.ZodString;
    receipt_id: z.ZodOptional<z.ZodString>;
    agent_session_id: z.ZodString;
    status: z.ZodEnum<{
        blocked: "blocked";
        succeeded: "succeeded";
        failed: "failed";
        partial: "partial";
        abandoned: "abandoned";
    }>;
    summary: z.ZodString;
    evidence: z.ZodDefault<z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            file: "file";
            command: "command";
            test: "test";
            build: "build";
            diff: "diff";
            human_feedback: "human_feedback";
            agent_statement: "agent_statement";
        }>;
        content: z.ZodString;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strict>>>;
    reported_at: z.ZodNumber;
    idempotency_key: z.ZodString;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const ReportOutcomeResponseSchema: z.ZodObject<{
    outcome_id: z.ZodString;
    work_thread_version: z.ZodNumber;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const ProtocolErrorSchema: z.ZodObject<{
    code: z.ZodEnum<{
        INVALID_ARGUMENT: "INVALID_ARGUMENT";
        UNAUTHENTICATED: "UNAUTHENTICATED";
        FORBIDDEN: "FORBIDDEN";
        NOT_FOUND: "NOT_FOUND";
        CONFLICT: "CONFLICT";
        UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION";
        RATE_LIMITED: "RATE_LIMITED";
        INTERNAL: "INTERNAL";
    }>;
    message: z.ZodString;
    request_id: z.ZodString;
    retryable: z.ZodBoolean;
    field: z.ZodOptional<z.ZodString>;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const DeviceAuthorizationStartRequestSchema: z.ZodObject<{
    device_name: z.ZodString;
    platform: z.ZodEnum<{
        "claude-code": "claude-code";
        codex: "codex";
        opencode: "opencode";
    }>;
    requested_scopes: z.ZodArray<z.ZodEnum<{
        "events:write": "events:write";
        "context:read": "context:read";
        "outcomes:write": "outcomes:write";
        "handoffs:create": "handoffs:create";
        "handoffs:claim": "handoffs:claim";
    }>>;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const DeviceAuthorizationStartResponseSchema: z.ZodObject<{
    device_code: z.ZodString;
    user_code: z.ZodString;
    verification_uri: z.ZodString;
    verification_uri_complete: z.ZodString;
    expires_in: z.ZodNumber;
    interval: z.ZodNumber;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const DeviceAuthorizationPollRequestSchema: z.ZodObject<{
    device_code: z.ZodString;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const DeviceAuthorizationPollResponseSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    state: z.ZodLiteral<"pending">;
    interval: z.ZodNumber;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>, z.ZodObject<{
    state: z.ZodLiteral<"authorized">;
    credential: z.ZodString;
    workspace_id: z.ZodString;
    agent_identity_id: z.ZodString;
    scopes: z.ZodArray<z.ZodEnum<{
        "events:write": "events:write";
        "context:read": "context:read";
        "outcomes:write": "outcomes:write";
        "handoffs:create": "handoffs:create";
        "handoffs:claim": "handoffs:claim";
    }>>;
    schema_version: z.ZodLiteral<1>;
}, z.core.$strict>], "state">;
export declare class UnsupportedProtocolVersionError extends Error {
    readonly received: unknown;
    constructor(received: unknown);
}
export declare function parseProtocol<T extends z.ZodType>(schema: T, input: unknown): z.infer<T>;
export type AgentScope = z.infer<typeof AgentScopeSchema>;
export type AgentPlatform = z.infer<typeof AgentPlatformSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type EventBatchRequest = z.infer<typeof EventBatchRequestSchema>;
export type EventBatchResponse = z.infer<typeof EventBatchResponseSchema>;
export type CreateWorkRequest = z.infer<typeof CreateWorkRequestSchema>;
export type CreateWorkResponse = z.infer<typeof CreateWorkResponseSchema>;
export type CreateHandoffRequest = z.infer<typeof CreateHandoffRequestSchema>;
export type CreateHandoffResponse = z.infer<typeof CreateHandoffResponseSchema>;
export type ClaimHandoffRequest = z.infer<typeof ClaimHandoffRequestSchema>;
export type ClaimHandoffResponse = z.infer<typeof ClaimHandoffResponseSchema>;
export type ResolveContextRequest = z.infer<typeof ResolveContextRequestSchema>;
export type ResolveContextResponse = z.infer<typeof ResolveContextResponseSchema>;
export type AcknowledgeReceiptRequest = z.infer<typeof AcknowledgeReceiptRequestSchema>;
export type AcknowledgeReceiptResponse = z.infer<typeof AcknowledgeReceiptResponseSchema>;
export type ReportOutcomeRequest = z.infer<typeof ReportOutcomeRequestSchema>;
export type ReportOutcomeResponse = z.infer<typeof ReportOutcomeResponseSchema>;
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;
export type DeviceAuthorizationStartRequest = z.infer<typeof DeviceAuthorizationStartRequestSchema>;
export type DeviceAuthorizationStartResponse = z.infer<typeof DeviceAuthorizationStartResponseSchema>;
export type DeviceAuthorizationPollRequest = z.infer<typeof DeviceAuthorizationPollRequestSchema>;
export type DeviceAuthorizationPollResponse = z.infer<typeof DeviceAuthorizationPollResponseSchema>;
