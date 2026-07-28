import { describe, expect, it, vi } from "vitest";
import { MemoryExtractionSchema, runOnce } from "../src/worker.js";

describe("memory extraction worker", () => {
  it("strictly rejects unknown memory types and fields", () => {
    expect(() => MemoryExtractionSchema.parse({ memories: [{ memory_type: "guess", content: "x", confidence: 1, status: "active" }] })).toThrow();
    expect(() => MemoryExtractionSchema.parse({ memories: [{ memory_type: "decision", content: "x", confidence: 1, status: "active", invented: true }] })).toThrow();
  });

  it("completes a queued job when no API key is configured", async () => {
    const updates: string[] = [];
    const db = { query: vi.fn(async (sql: string) => {
      if (sql.startsWith("UPDATE alpha_sync_jobs SET state='running'")) return { rows: [{ id: "job-1", workspace_id: "workspace-1", provider: "extraction", payload_json: {} }], rowCount: 1 };
      updates.push(sql); return { rows: [], rowCount: 1 };
    }) } as any;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await runOnce(db, { model: "test", baseUrl: "https://llm.test", timeoutMs: 100, extractionVersion: "v1" })).toBe(true);
    expect(warning).toHaveBeenCalledWith("Extraction skipped: No API key configured");
    expect(updates.some((sql) => sql.includes("state='succeeded'"))).toBe(true);
    warning.mockRestore();
  });
});
