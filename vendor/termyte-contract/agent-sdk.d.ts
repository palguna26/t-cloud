import { type AgentEvent, type DeviceAuthorizationStartRequest, type ResolveContextRequest } from "./protocol.js";
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
    appendEvents(input: {
        events: AgentEvent[];
    }): Promise<{
        accepted_event_ids: string[];
        existing_event_ids: string[];
        schema_version: 3;
    }>;
    resolveContext(input: Omit<ResolveContextRequest, "schema_version">): Promise<{
        state: "context";
        receipt_id: string;
        task_mode: "implement" | "investigate" | "review" | "verify" | "continue" | "general";
        items: {
            item_id: string;
            type: "decision" | "constraint" | "attempt" | "evidence" | "outcome" | "fact" | "requirement" | "discovery" | "open_question";
            text: string;
            status: "observed" | "inferred" | "verified" | "proposed" | "conflicting" | "stale";
            confidence: number;
            task_relevance: number;
            company_relevance: number;
            task_reason: string;
            company_reason: string;
            source: {
                source_record_id: string;
                provider: "github" | "slack" | "agent";
                title: string;
                occurred_at: number;
                url?: string | undefined;
                author?: string | undefined;
            };
        }[];
        omitted_count: number;
        expires_at: number;
        schema_version: 3;
    } | {
        state: "abstained";
        receipt_id: string;
        code: "low_confidence" | "no_match" | "no_authorized_sources" | "no_indexed_sources";
        message: string;
        schema_version: 3;
    }>;
    acknowledgeReceipt(receiptId: string, input: any): Promise<{
        acknowledged: true;
        schema_version: 3;
    }>;
    reportOutcome(input: any): Promise<{
        outcome_id: string;
        schema_version: 3;
    }>;
    refreshContext(input: any): Promise<any>;
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
        schema_version: 3;
    }>;
    poll(deviceCode: string): Promise<{
        state: "pending";
        interval: number;
        schema_version: 3;
    } | {
        state: "authorized";
        credential: string;
        workspace_id: string;
        agent_identity_id: string;
        scopes: ("events:write" | "context:read" | "outcomes:write")[];
        schema_version: 3;
    }>;
    private publicRequest;
}
