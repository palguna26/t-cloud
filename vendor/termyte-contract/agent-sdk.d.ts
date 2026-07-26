import { type AcknowledgeReceiptRequest, type ClaimHandoffRequest, type CreateHandoffRequest, type CreateWorkRequest, type DeviceAuthorizationPollRequest, type DeviceAuthorizationStartRequest, type EventBatchRequest, type RefreshContextRequest, type ReportOutcomeRequest, type ResolveContextRequest } from "./protocol.js";
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
    appendEvents(input: Omit<EventBatchRequest, "schema_version">): Promise<any>;
    createWork(input: Omit<CreateWorkRequest, "schema_version">): Promise<any>;
    createHandoff(input: Omit<CreateHandoffRequest, "schema_version">): Promise<any>;
    claimHandoff(handoffId: string, input: Omit<ClaimHandoffRequest, "schema_version">): Promise<any>;
    resolveContext(input: Omit<ResolveContextRequest, "schema_version">): Promise<any>;
    refreshContext(input: Omit<RefreshContextRequest, "schema_version">): Promise<any>;
    acknowledgeReceipt(receiptId: string, input: Omit<AcknowledgeReceiptRequest, "schema_version">): Promise<any>;
    reportOutcome(input: Omit<ReportOutcomeRequest, "schema_version">): Promise<any>;
    private request;
}
export declare class TermyteDeviceClient {
    private readonly baseUrl;
    private readonly fetcher;
    constructor(baseUrl: string, fetcher?: typeof fetch);
    start(input: Omit<DeviceAuthorizationStartRequest, "schema_version">): Promise<any>;
    poll(deviceCode: string): Promise<any>;
    private publicRequest;
}
