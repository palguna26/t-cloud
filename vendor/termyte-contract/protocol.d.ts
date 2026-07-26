export declare const TERMYTE_PROTOCOL_VERSION: 2;

export declare const AgentScopeSchema: any;
export declare const AgentPlatformSchema: any;
export declare const WorkThreadStatusSchema: any;
export declare const ContextItemTypeSchema: any;
export declare const AgentEventTypeSchema: any;
export declare const AgentEventSchema: any;
export declare const EventBatchRequestSchema: any;
export declare const EventBatchResponseSchema: any;
export declare const CreateWorkRequestSchema: any;
export declare const WorkThreadSchema: any;
export declare const CreateWorkResponseSchema: any;
export declare const CreateHandoffRequestSchema: any;
export declare const HandoffSchema: any;
export declare const CreateHandoffResponseSchema: any;
export declare const ClaimHandoffRequestSchema: any;
export declare const ClaimHandoffResponseSchema: any;
export declare const ResolveContextRequestSchema: any;
export declare const ContextSourceSchema: any;
export declare const ResolvedContextResponseSchema: any;
export declare const ClarificationContextResponseSchema: any;
export declare const NotFoundContextResponseSchema: any;
export declare const ResolveContextResponseSchema: any;
export declare const AcknowledgeReceiptRequestSchema: any;
export declare const AcknowledgeReceiptResponseSchema: any;
export declare const RefreshContextRequestSchema: any;
export declare const PendingRefreshContextResponseSchema: any;
export declare const UnchangedRefreshContextResponseSchema: any;
export declare const BindingLostContextResponseSchema: any;
export declare const RefreshContextResponseSchema: any;
export declare const ReportOutcomeRequestSchema: any;
export declare const ReportOutcomeResponseSchema: any;
export declare const ProtocolErrorSchema: any;
export declare const DeviceAuthorizationStartRequestSchema: any;
export declare const DeviceAuthorizationStartResponseSchema: any;
export declare const DeviceAuthorizationPollRequestSchema: any;
export declare const DeviceAuthorizationPollResponseSchema: any;

export declare class UnsupportedProtocolVersionError extends Error {
  readonly received: unknown;
  constructor(received: unknown);
}

export declare function parseProtocol<T>(schema: T, input: unknown): T extends { parse: (...args: any[]) => infer R } ? R : any;

export type AgentScope = "events:write" | "context:read" | "outcomes:write" | "handoffs:create" | "handoffs:claim";
export type AgentPlatform = "claude-code" | "codex" | "opencode";
export type TaskMode = "implement" | "investigate" | "review" | "verify" | "continue" | "general";
export type ReceiptType = "initial" | "delta" | "full_refresh" | "cached_fallback";
export type DeliveryStatus = "pending" | "delivered" | "failed" | "expired";

export type CreateWorkRequest = any;
export type CreateWorkResponse = any;
export type CreateHandoffRequest = any;
export type CreateHandoffResponse = any;
export type ClaimHandoffRequest = any;
export type ClaimHandoffResponse = any;
export type ResolveContextRequest = any;
export type ResolveContextResponse = any;
export type RefreshContextRequest = any;
export type RefreshContextResponse = any;
export type AcknowledgeReceiptRequest = any;
export type AcknowledgeReceiptResponse = any;
export type ReportOutcomeRequest = any;
export type ReportOutcomeResponse = any;
export type DeviceAuthorizationStartRequest = any;
export type DeviceAuthorizationStartResponse = any;
export type DeviceAuthorizationPollRequest = any;
export type DeviceAuthorizationPollResponse = any;
export type EventBatchRequest = any;
export type EventBatchResponse = any;
