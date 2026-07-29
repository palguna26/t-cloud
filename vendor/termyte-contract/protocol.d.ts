import { z } from "zod";
export declare const TERMYTE_PROTOCOL_VERSION: 3;
export declare const AgentPlatformSchema: z.ZodEnum<{
    codex: "codex";
    "claude-code": "claude-code";
}>;
export declare const TaskModeSchema: z.ZodEnum<{
    implement: "implement";
    investigate: "investigate";
    review: "review";
    verify: "verify";
    continue: "continue";
    general: "general";
}>;
export declare const TrustStatusSchema: z.ZodEnum<{
    observed: "observed";
    inferred: "inferred";
    verified: "verified";
    proposed: "proposed";
    conflicting: "conflicting";
    stale: "stale";
}>;
export declare const SourceProviderSchema: z.ZodEnum<{
    local: "local";
    github: "github";
    slack: "slack";
    linear: "linear";
    agent: "agent";
}>;
export declare const DeliveryStatusSchema: z.ZodEnum<{
    delivered: "delivered";
    failed: "failed";
}>;
export declare const AbstentionCodeSchema: z.ZodEnum<{
    low_confidence: "low_confidence";
    no_match: "no_match";
    no_authorized_sources: "no_authorized_sources";
    no_indexed_sources: "no_indexed_sources";
}>;
export declare const AgentEventTypeSchema: z.ZodEnum<{
    session_started: "session_started";
    user_prompt: "user_prompt";
    observation: "observation";
    decision: "decision";
    constraint: "constraint";
    action: "action";
    attempt: "attempt";
    failure: "failure";
    evidence: "evidence";
    status_changed: "status_changed";
    outcome: "outcome";
    session_ended: "session_ended";
}>;
export declare const AgentScopeSchema: z.ZodEnum<{
    "events:write": "events:write";
    "context:read": "context:read";
    "outcomes:write": "outcomes:write";
}>;
export declare const AgentEventSchema: z.ZodObject<{
    event_id: z.ZodString;
    event_type: z.ZodEnum<{
        session_started: "session_started";
        user_prompt: "user_prompt";
        observation: "observation";
        decision: "decision";
        constraint: "constraint";
        action: "action";
        attempt: "attempt";
        failure: "failure";
        evidence: "evidence";
        status_changed: "status_changed";
        outcome: "outcome";
        session_ended: "session_ended";
    }>;
    agent_session_id: z.ZodString;
    occurred_at: z.ZodNumber;
    source: z.ZodObject<{
        platform: z.ZodEnum<{
            codex: "codex";
            "claude-code": "claude-code";
        }>;
        external_id: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    repository_key: z.ZodOptional<z.ZodString>;
    branch: z.ZodOptional<z.ZodString>;
    receipt_id: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodString>;
    files: z.ZodOptional<z.ZodArray<z.ZodString>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strict>;
export declare const EventBatchRequestSchema: z.ZodObject<{
    events: z.ZodArray<z.ZodObject<{
        event_id: z.ZodString;
        event_type: z.ZodEnum<{
            session_started: "session_started";
            user_prompt: "user_prompt";
            observation: "observation";
            decision: "decision";
            constraint: "constraint";
            action: "action";
            attempt: "attempt";
            failure: "failure";
            evidence: "evidence";
            status_changed: "status_changed";
            outcome: "outcome";
            session_ended: "session_ended";
        }>;
        agent_session_id: z.ZodString;
        occurred_at: z.ZodNumber;
        source: z.ZodObject<{
            platform: z.ZodEnum<{
                codex: "codex";
                "claude-code": "claude-code";
            }>;
            external_id: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        repository_key: z.ZodOptional<z.ZodString>;
        branch: z.ZodOptional<z.ZodString>;
        receipt_id: z.ZodOptional<z.ZodString>;
        content: z.ZodOptional<z.ZodString>;
        files: z.ZodOptional<z.ZodArray<z.ZodString>>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strict>>;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>;
export declare const EventBatchResponseSchema: z.ZodObject<{
    accepted_event_ids: z.ZodArray<z.ZodString>;
    existing_event_ids: z.ZodArray<z.ZodString>;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>;
export declare const ResolveContextRequestSchema: z.ZodObject<{
    request_text: z.ZodString;
    agent_session_id: z.ZodString;
    repository_key: z.ZodString;
    branch: z.ZodOptional<z.ZodString>;
    changed_files: z.ZodArray<z.ZodString>;
    recent_files: z.ZodArray<z.ZodString>;
    explicit_references: z.ZodArray<z.ZodString>;
    task_mode_hint: z.ZodOptional<z.ZodEnum<{
        implement: "implement";
        investigate: "investigate";
        review: "review";
        verify: "verify";
        continue: "continue";
        general: "general";
    }>>;
    previous_receipt_id: z.ZodOptional<z.ZodString>;
    cloud_token_budget: z.ZodNumber;
    idempotency_key: z.ZodString;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>;
export declare const ResolvedContextResponseSchema: z.ZodObject<{
    state: z.ZodLiteral<"context">;
    receipt_id: z.ZodString;
    task_mode: z.ZodEnum<{
        implement: "implement";
        investigate: "investigate";
        review: "review";
        verify: "verify";
        continue: "continue";
        general: "general";
    }>;
    items: z.ZodArray<z.ZodObject<{
        item_id: z.ZodString;
        type: z.ZodEnum<{
            decision: "decision";
            constraint: "constraint";
            attempt: "attempt";
            evidence: "evidence";
            outcome: "outcome";
            fact: "fact";
            requirement: "requirement";
            discovery: "discovery";
            open_question: "open_question";
        }>;
        text: z.ZodString;
        status: z.ZodEnum<{
            observed: "observed";
            inferred: "inferred";
            verified: "verified";
            proposed: "proposed";
            conflicting: "conflicting";
            stale: "stale";
        }>;
        confidence: z.ZodNumber;
        task_relevance: z.ZodNumber;
        company_relevance: z.ZodNumber;
        task_reason: z.ZodString;
        company_reason: z.ZodString;
        source: z.ZodObject<{
            source_record_id: z.ZodString;
            provider: z.ZodEnum<{
                github: "github";
                slack: "slack";
                linear: "linear";
                agent: "agent";
            }>;
            title: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
            author: z.ZodOptional<z.ZodString>;
            occurred_at: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    omitted_count: z.ZodNumber;
    expires_at: z.ZodNumber;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>;
export declare const AbstainedContextResponseSchema: z.ZodObject<{
    state: z.ZodLiteral<"abstained">;
    receipt_id: z.ZodString;
    code: z.ZodEnum<{
        low_confidence: "low_confidence";
        no_match: "no_match";
        no_authorized_sources: "no_authorized_sources";
        no_indexed_sources: "no_indexed_sources";
    }>;
    message: z.ZodString;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>;
export declare const ResolveContextResponseSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    state: z.ZodLiteral<"context">;
    receipt_id: z.ZodString;
    task_mode: z.ZodEnum<{
        implement: "implement";
        investigate: "investigate";
        review: "review";
        verify: "verify";
        continue: "continue";
        general: "general";
    }>;
    items: z.ZodArray<z.ZodObject<{
        item_id: z.ZodString;
        type: z.ZodEnum<{
            decision: "decision";
            constraint: "constraint";
            attempt: "attempt";
            evidence: "evidence";
            outcome: "outcome";
            fact: "fact";
            requirement: "requirement";
            discovery: "discovery";
            open_question: "open_question";
        }>;
        text: z.ZodString;
        status: z.ZodEnum<{
            observed: "observed";
            inferred: "inferred";
            verified: "verified";
            proposed: "proposed";
            conflicting: "conflicting";
            stale: "stale";
        }>;
        confidence: z.ZodNumber;
        task_relevance: z.ZodNumber;
        company_relevance: z.ZodNumber;
        task_reason: z.ZodString;
        company_reason: z.ZodString;
        source: z.ZodObject<{
            source_record_id: z.ZodString;
            provider: z.ZodEnum<{
                github: "github";
                slack: "slack";
                linear: "linear";
                agent: "agent";
            }>;
            title: z.ZodString;
            url: z.ZodOptional<z.ZodString>;
            author: z.ZodOptional<z.ZodString>;
            occurred_at: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    omitted_count: z.ZodNumber;
    expires_at: z.ZodNumber;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>, z.ZodObject<{
    state: z.ZodLiteral<"abstained">;
    receipt_id: z.ZodString;
    code: z.ZodEnum<{
        low_confidence: "low_confidence";
        no_match: "no_match";
        no_authorized_sources: "no_authorized_sources";
        no_indexed_sources: "no_indexed_sources";
    }>;
    message: z.ZodString;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>], "state">;
export declare const AcknowledgeReceiptRequestSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    delivery_status: z.ZodLiteral<"delivered">;
    delivered_at: z.ZodNumber;
    final_packet: z.ZodString;
    final_packet_sha256: z.ZodString;
    local_item_count: z.ZodNumber;
    cloud_item_ids: z.ZodArray<z.ZodString>;
    idempotency_key: z.ZodString;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>, z.ZodObject<{
    delivery_status: z.ZodLiteral<"failed">;
    failure_code: z.ZodString;
    idempotency_key: z.ZodString;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>], "delivery_status">;
export declare const AcknowledgeReceiptResponseSchema: z.ZodObject<{
    acknowledged: z.ZodLiteral<true>;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>;
export declare const ReportOutcomeRequestSchema: z.ZodObject<{
    agent_session_id: z.ZodString;
    receipt_id: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<{
        failed: "failed";
        succeeded: "succeeded";
        partial: "partial";
        blocked: "blocked";
        abandoned: "abandoned";
    }>;
    summary: z.ZodString;
    evidence: z.ZodArray<z.ZodObject<{
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
    }, z.core.$strict>>;
    reported_at: z.ZodNumber;
    idempotency_key: z.ZodString;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>;
export declare const ReportOutcomeResponseSchema: z.ZodObject<{
    outcome_id: z.ZodString;
    schema_version: z.ZodLiteral<3>;
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
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>;
export declare const DeviceAuthorizationStartRequestSchema: z.ZodObject<{
    device_name: z.ZodString;
    platform: z.ZodEnum<{
        codex: "codex";
        "claude-code": "claude-code";
    }>;
    requested_scopes: z.ZodArray<z.ZodEnum<{
        "events:write": "events:write";
        "context:read": "context:read";
        "outcomes:write": "outcomes:write";
    }>>;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>;
export declare const DeviceAuthorizationStartResponseSchema: z.ZodObject<{
    device_code: z.ZodString;
    user_code: z.ZodString;
    verification_uri: z.ZodString;
    verification_uri_complete: z.ZodString;
    expires_in: z.ZodNumber;
    interval: z.ZodNumber;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>;
export declare const DeviceAuthorizationPollResponseSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    state: z.ZodLiteral<"pending">;
    interval: z.ZodNumber;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>, z.ZodObject<{
    state: z.ZodLiteral<"authorized">;
    credential: z.ZodString;
    workspace_id: z.ZodString;
    agent_identity_id: z.ZodString;
    scopes: z.ZodArray<z.ZodEnum<{
        "events:write": "events:write";
        "context:read": "context:read";
        "outcomes:write": "outcomes:write";
    }>>;
    schema_version: z.ZodLiteral<3>;
}, z.core.$strict>], "state">;
export declare class UnsupportedProtocolVersionError extends Error {
    readonly received: unknown;
    constructor(received: unknown);
}
export declare function parseProtocol<T extends z.ZodType>(schema: T, input: unknown): z.infer<T>;
export type AgentPlatform = z.infer<typeof AgentPlatformSchema>;
export type TaskMode = z.infer<typeof TaskModeSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type EventBatchRequest = z.infer<typeof EventBatchRequestSchema>;
export type ResolveContextRequest = z.infer<typeof ResolveContextRequestSchema>;
export type ResolveContextResponse = z.infer<typeof ResolveContextResponseSchema>;
export type AcknowledgeReceiptRequest = z.infer<typeof AcknowledgeReceiptRequestSchema>;
export type ReportOutcomeRequest = z.infer<typeof ReportOutcomeRequestSchema>;
export type AgentScope = z.infer<typeof AgentScopeSchema>;
export declare const RefreshContextResponseSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export type DeviceAuthorizationStartRequest = z.infer<typeof DeviceAuthorizationStartRequestSchema>;
