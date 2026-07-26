import { z } from "zod";
import { TERMYTE_PROTOCOL_VERSION } from "termyte/protocol";

// Internal-only shapes used by the pre-v3 Work Thread service. They never cross
// the launch API; server routes validate public requests with protocol v3.
export { TERMYTE_PROTOCOL_VERSION };
export const CreateWorkRequestSchema = z.any();
export const CreateHandoffRequestSchema = z.any();
export const ClaimHandoffRequestSchema = z.any();
export const RefreshContextRequestSchema = z.any();
export const DeviceAuthorizationPollRequestSchema = z.any();
export type CreateWorkRequest = any;
export type CreateHandoffRequest = any;
export type ClaimHandoffRequest = any;
export type RefreshContextRequest = any;
export type RefreshContextResponse = any;
export type ResolveContextRequest = any;
export type ResolveContextResponse = any;
export type AcknowledgeReceiptRequest = any;
export type ReportOutcomeRequest = any;
