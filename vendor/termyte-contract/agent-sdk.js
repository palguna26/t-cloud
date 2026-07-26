import { z } from "zod";
import { AcknowledgeReceiptResponseSchema, DeviceAuthorizationPollResponseSchema, DeviceAuthorizationStartResponseSchema, EventBatchResponseSchema, ProtocolErrorSchema, ReportOutcomeResponseSchema, ResolveContextResponseSchema, TERMYTE_PROTOCOL_VERSION, parseProtocol } from "./protocol.js";
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
    constructor(options) { this.baseUrl = options.baseUrl.replace(/\/+$/, ""); this.credential = options.credential; this.timeoutMs = options.timeoutMs ?? 1_500; this.fetcher = options.fetch ?? fetch; }
    appendEvents(input) { return this.request("/v1/events/batch", input, EventBatchResponseSchema); }
    resolveContext(input) { return this.request("/v1/context/resolve", input, ResolveContextResponseSchema); }
    acknowledgeReceipt(receiptId, input) { return this.request(`/v1/receipts/${encodeURIComponent(receiptId)}/ack`, input, AcknowledgeReceiptResponseSchema); }
    reportOutcome(input) { return this.request("/v1/outcomes", input, ReportOutcomeResponseSchema); }
    refreshContext(input) { return this.request("/v1/context/refresh", input, z.any()); }
    async request(path, body, schema) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetcher(`${this.baseUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${this.credential}`, "content-type": "application/json" }, body: JSON.stringify({ schema_version: TERMYTE_PROTOCOL_VERSION, ...body }), signal: controller.signal });
            const payload = await response.json();
            if (!response.ok) {
                const error = ProtocolErrorSchema.safeParse(payload);
                throw new TermyteCloudError(error.success ? error.data.code : "INVALID_RESPONSE", error.success ? error.data.message : `Termyte returned HTTP ${response.status}`, response.status, error.success ? error.data.retryable : response.status >= 500 || response.status === 429, error.success ? error.data.request_id : undefined);
            }
            return parseProtocol(schema, payload);
        }
        catch (error) {
            if (error instanceof TermyteCloudError)
                throw error;
            throw new TermyteCloudError(controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR", error instanceof Error ? error.message : String(error), 0, true);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
export class TermyteDeviceClient {
    baseUrl;
    fetcher;
    constructor(baseUrl, fetcher = fetch) {
        this.baseUrl = baseUrl;
        this.fetcher = fetcher;
    }
    start(input) { return this.publicRequest("/v1/device/start", input, DeviceAuthorizationStartResponseSchema); }
    poll(deviceCode) { return this.publicRequest("/v1/device/token", { device_code: deviceCode }, DeviceAuthorizationPollResponseSchema); }
    async publicRequest(path, body, schema) { const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/, "")}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schema_version: TERMYTE_PROTOCOL_VERSION, ...body }) }); const payload = await response.json(); if (!response.ok)
        throw new TermyteCloudError("HTTP_ERROR", `Termyte returned HTTP ${response.status}`, response.status, response.status >= 500 || response.status === 429); return parseProtocol(schema, payload); }
}
//# sourceMappingURL=agent-sdk.js.map