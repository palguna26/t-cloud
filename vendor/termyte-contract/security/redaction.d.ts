export interface RedactionMetadata {
    applied: boolean;
    findings: string[];
}
export interface RedactionResult<T> {
    value: T;
    redaction: RedactionMetadata;
}
export declare function redactTracePayload(input: {
    tool_input: unknown;
    tool_output: unknown;
    user_prompt: string | null;
    final_response: string | null;
}): RedactionResult<{
    tool_input: unknown;
    tool_output: unknown;
    user_prompt: string | null;
    final_response: string | null;
}>;
export declare function redactText(input: string, path?: string, findings?: string[]): string;
export declare function redactValue<T>(input: T, path?: string, findings?: string[]): RedactionResult<T>;
