const SENSITIVE_KEYS = new Set([
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "client_secret",
    "private_key",
    "privatekey",
    "secret_access_key",
    "session_token",
    "authorization",
    "cookie",
]);
export function redactTracePayload(input) {
    const findings = [];
    const toolInput = redactValue(input.tool_input, "tool_input", findings);
    const toolOutput = redactValue(input.tool_output, "tool_output", findings);
    const userPrompt = input.user_prompt == null
        ? null
        : redactText(input.user_prompt, "user_prompt", findings);
    const finalResponse = input.final_response == null
        ? null
        : redactText(input.final_response, "final_response", findings);
    return {
        value: {
            tool_input: toolInput.value,
            tool_output: toolOutput.value,
            user_prompt: userPrompt,
            final_response: finalResponse,
        },
        redaction: {
            applied: findings.length > 0,
            findings,
        },
    };
}
export function redactText(input, path = "text", findings = []) {
    let output = input;
    const rules = [
        ["private_key_block", /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED:private_key]"],
        ["jwt", /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, "[REDACTED:jwt]"],
        ["openai_key", /\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED:api_key]"],
        ["github_token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED:github_token]"],
        ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws_access_key]"],
        ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED:slack_token]"],
        ["bearer_token", /\bBearer\s+[A-Za-z0-9\-._~+/=]{16,}\b/g, "Bearer [REDACTED:bearer_token]"],
        ["url_credentials", /\bhttps?:\/\/([^/\s:@]+):([^/\s@]+)@/g, (_match, user) => `https://${user}:[REDACTED]@`],
        ["env_assignment", /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY)[A-Z0-9_]*)\s*=\s*([^\s'"`<>{}\[\]]{4,})/g, (_match, name) => `${name}=[REDACTED:${normalizeKey(name)}]`],
        ["key_value", /\b(password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?token)\b\s*([:=])\s*([^\s'"`<>{}\[\]]{4,})/gi, (_match, key, sep) => `${key}${sep} [REDACTED:${normalizeKey(key)}]`],
    ];
    for (const [name, regex, replacement] of rules) {
        regex.lastIndex = 0;
        if (!regex.test(output))
            continue;
        regex.lastIndex = 0;
        output = output.replace(regex, (...args) => {
            findings.push(`${path}:${name}`);
            if (typeof replacement === "string")
                return replacement;
            return replacement(args[0] ?? "", args[1] ?? "", args[2] ?? "", args[3] ?? "", args[4] ?? "");
        });
    }
    return output;
}
export function redactValue(input, path = "value", findings = []) {
    const value = redactUnknown(input, path, findings);
    return {
        value,
        redaction: {
            applied: findings.length > 0,
            findings,
        },
    };
}
function redactUnknown(input, path, findings) {
    if (input === null || input === undefined)
        return input;
    if (typeof input === "string")
        return redactText(input, path, findings);
    if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint")
        return input;
    if (input instanceof Date)
        return input.toISOString();
    if (input instanceof Uint8Array || input instanceof Float32Array)
        return input;
    if (Array.isArray(input)) {
        return input.map((item, index) => redactUnknown(item, `${path}[${index}]`, findings));
    }
    if (typeof input !== "object")
        return input;
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        const childPath = `${path}.${key}`;
        if (isSensitiveKey(key)) {
            findings.push(`${childPath}:key`);
            out[key] = `[REDACTED:${normalizeKey(key)}]`;
            continue;
        }
        out[key] = redactUnknown(value, childPath, findings);
    }
    return out;
}
function isSensitiveKey(key) {
    const normalized = normalizeKey(key);
    return SENSITIVE_KEYS.has(normalized);
}
function normalizeKey(key) {
    return key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
//# sourceMappingURL=redaction.js.map