import { type AcknowledgeReceiptRequest, type ClaimHandoffRequest, type CreateHandoffRequest, type CreateWorkRequest, type EventBatchRequest, type DeviceAuthorizationStartRequest, type ReportOutcomeRequest, type ResolveContextRequest } from "./protocol.js";
export interface TermyteAgentClientOptions {
    baseUrl: string;
    credential: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
}
export declare class TermyteCloudError extends Error {
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;
    readonly requestId?: string | undefined;
    constructor(code: string, message: string, status: number, retryable: boolean, requestId?: string | undefined);
}
export declare class TermyteAgentClient {
    private readonly baseUrl;
    private readonly credential;
    private readonly timeoutMs;
    private readonly fetcher;
    constructor(options: TermyteAgentClientOptions);
    appendEvents(input: Omit<EventBatchRequest, "schema_version">): Promise<{
        accepted_event_ids: string[];
        existing_event_ids: string[];
        schema_version: 1;
    }>;
    createWork(input: Omit<CreateWorkRequest, "schema_version">): Promise<{
        work_thread: {
            id: string;
            title: string;
            objective: string;
            status: "proposed" | "active" | "blocked" | "in_review" | "completed" | "cancelled" | "archived";
            version: number;
            repository_key: string | null;
            created_at: number;
            updated_at: number;
        };
        schema_version: 1;
    }>;
    createHandoff(input: Omit<CreateHandoffRequest, "schema_version">): Promise<{
        handoff: {
            id: string;
            work_thread_id: string;
            from_agent_identity_id: string;
            to_agent_identity_id: string;
            instruction: string;
            status: "completed" | "cancelled" | "ready" | "claimed" | "expired";
            created_at: number;
            claimed_at: number | null;
            completed_at: number | null;
            expires_at: number | null;
        };
        schema_version: 1;
    }>;
    claimHandoff(handoffId: string, input: Omit<ClaimHandoffRequest, "schema_version">): Promise<{
        handoff: {
            id: string;
            work_thread_id: string;
            from_agent_identity_id: string;
            to_agent_identity_id: string;
            instruction: string;
            status: "completed" | "cancelled" | "ready" | "claimed" | "expired";
            created_at: number;
            claimed_at: number | null;
            completed_at: number | null;
            expires_at: number | null;
        };
        work_thread: {
            id: string;
            title: string;
            objective: string;
            status: "proposed" | "active" | "blocked" | "in_review" | "completed" | "cancelled" | "archived";
            version: number;
            repository_key: string | null;
            created_at: number;
            updated_at: number;
        };
        schema_version: 1;
    }>;
    resolveContext(input: Omit<ResolveContextRequest, "schema_version">): Promise<{
        state: "resolved";
        work_thread_id: string;
        work_thread_version: number;
        receipt_id: string;
        briefing: string;
        estimated_tokens: number;
        sources: {
            context_item_id: string;
            type: "objective" | "current_state" | "decision" | "constraint" | "observation" | "attempt" | "failure" | "blocker" | "evidence" | "expected_result" | "next_action" | "outcome";
            source_event_ids: string[];
            inclusion_reason: string;
        }[];
        expires_at: number;
        schema_version: 1;
    } | {
        state: "clarification_required";
        question: string;
        candidates: {
            work_thread_id: string;
            label: string;
        }[];
        schema_version: 1;
    } | {
        state: "not_found";
        message: string;
        schema_version: 1;
    }>;
    acknowledgeReceipt(receiptId: string, input: Omit<AcknowledgeReceiptRequest, "schema_version">): Promise<{
        acknowledged: true;
        schema_version: 1;
    }>;
    reportOutcome(input: Omit<ReportOutcomeRequest, "schema_version">): Promise<{
        outcome_id: string;
        work_thread_version: number;
        schema_version: 1;
    }>;
    private request;
}
export declare class TermyteDeviceClient {
    private readonly baseUrl;
    private readonly fetcher;
    constructor(baseUrl: string, fetcher?: typeof fetch);
    start(input: Omit<DeviceAuthorizationStartRequest, "schema_version">): Promise<{
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
        expires_in: number;
        interval: number;
        schema_version: 1;
    }>;
    poll(deviceCode: string): Promise<{
        state: "pending";
        interval: number;
        schema_version: 1;
    } | {
        state: "authorized";
        credential: string;
        workspace_id: string;
        agent_identity_id: string;
        scopes: ("events:write" | "context:read" | "outcomes:write" | "handoffs:create" | "handoffs:claim")[];
        schema_version: 1;
    }>;
    private publicRequest;
}
