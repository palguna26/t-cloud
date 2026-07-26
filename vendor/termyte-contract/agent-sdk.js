import { AcknowledgeReceiptResponseSchema, ClaimHandoffResponseSchema, CreateHandoffResponseSchema, CreateWorkResponseSchema, DeviceAuthorizationPollResponseSchema, DeviceAuthorizationStartResponseSchema, EventBatchResponseSchema, ProtocolErrorSchema, RefreshContextResponseSchema, ReportOutcomeResponseSchema, ResolveContextResponseSchema, TERMYTE_PROTOCOL_VERSION, parseProtocol, } from "./protocol.js";
export class TermyteCloudError extends Error {
    code;
    status;
    retryable;
    requestId;
    constructor(code, message, status, retryable, requestId) {
        super(message);
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.requestId = requestId;
        this.name = "TermyteCloudError";
    }
}
export class TermyteAgentClient {
    baseUrl;
    credential;
    timeoutMs;
    fetcher;
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.credential = options.credential;
        this.timeoutMs = options.timeoutMs ?? 1_500;
        this.fetcher = options.fetch ?? fetch;
    }
    appendEvents(input) {
        return this.request("/v1/events/batch", input, EventBatchResponseSchema);
    }
    createWork(input) {
        return this.request("/v1/work", input, CreateWorkResponseSchema);
    }
    createHandoff(input) {
        return this.request("/v1/handoffs", input, CreateHandoffResponseSchema);
    }
    claimHandoff(handoffId, input) {
        return this.request(`/v1/handoffs/${encodeURIComponent(handoffId)}/claim`, input, ClaimHandoffResponseSchema);
    }
    resolveContext(input) {
        return this.request("/v1/context/resolve", input, ResolveContextResponseSchema);
    }
    refreshContext(input) {
        return this.request("/v1/context/refresh", input, RefreshContextResponseSchema);
    }
    acknowledgeReceipt(receiptId, input) {
        return this.request(`/v1/receipts/${encodeURIComponent(receiptId)}/ack`, input, AcknowledgeReceiptResponseSchema);
    }
    reportOutcome(input) {
        return this.request("/v1/outcomes", input, ReportOutcomeResponseSchema);
    }
    async request(path, body, schema) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetcher(`${this.baseUrl}${path}`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${this.credential}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    schema_version: TERMYTE_PROTOCOL_VERSION,
                    ...body,
                }),
                signal: controller.signal,
            });
            const payload = await response.json();
            if (!response.ok) {
                const error = ProtocolErrorSchema.safeParse(payload);
                throw new TermyteCloudError(error.success ? error.data.code : "INVALID_RESPONSE", error.success ? error.data.message : `Termyte returned HTTP ${response.status}`, response.status, error.success && error.data.retryable, error.success ? error.data.request_id : undefined);
            }
            return parseProtocol(schema, payload);
        }
        catch (error) {
            if (error instanceof TermyteCloudError)
                throw error;
            if (controller.signal.aborted) {
                throw new TermyteCloudError("TIMEOUT", "Termyte request timed out", 0, true);
            }
            throw new TermyteCloudError("NETWORK_ERROR", error instanceof Error ? error.message : String(error), 0, true);
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
export class TermyteDeviceClient {
    baseUrl;
    fetcher;
    constructor(baseUrl, fetcher = fetch) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.fetcher = fetcher;
    }
    async start(input) {
        return this.publicRequest("/v1/device/start", input, DeviceAuthorizationStartResponseSchema);
    }
    async poll(deviceCode) {
        return this.publicRequest("/v1/device/token", { device_code: deviceCode }, DeviceAuthorizationPollResponseSchema);
    }
    async publicRequest(path, body, schema) {
        const response = await this.fetcher(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ schema_version: TERMYTE_PROTOCOL_VERSION, ...body }),
        });
        const payload = await response.json();
        if (!response.ok) {
            const error = ProtocolErrorSchema.safeParse(payload);
            throw new TermyteCloudError(error.success ? error.data.code : "INVALID_RESPONSE", error.success ? error.data.message : `Termyte returned HTTP ${response.status}`, response.status, error.success && error.data.retryable, error.success ? error.data.request_id : undefined);
        }
        return parseProtocol(schema, payload);
    }
}
