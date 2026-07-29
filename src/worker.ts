import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createDatabase, type Database } from "./db.js";

const MemoryType = z.enum(["decision", "requirement", "problem", "failed_attempt", "progress", "outcome", "unfinished_work"]);
const MemoryStatus = z.enum(["active", "superseded", "completed", "unknown"]);
export const MemoryExtractionSchema = z.object({ memories: z.array(z.object({
  memory_type: MemoryType,
  content: z.string().trim().min(1).max(20_000),
  confidence: z.number().min(0).max(1),
  status: MemoryStatus,
  work_thread_id: z.string().trim().min(1).max(500).nullable().optional(),
}).strict()).max(50) }).strict();

export interface Job { id: string; workspace_id: string; provider: string; payload_json: Record<string, unknown>; }
export interface ExtractionConfig { apiKey?: string; model: string; baseUrl: string; timeoutMs: number; extractionVersion: string; fetch?: typeof fetch; }
type SubjectType = "source_record" | "agent_session";
type Queryable = Database | pg.PoolClient;

export function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export async function enqueueExtractionJob(db: Queryable, workspaceId: string, subjectType: SubjectType, subjectId: string, extractionVersion: string): Promise<void> {
  const id = stableUuid(`extract:${subjectType}:${subjectId}:${extractionVersion}`);
  await db.query(`
    INSERT INTO alpha_sync_jobs (id, workspace_id, provider, payload_json, state)
    VALUES ($1, $2, 'extraction', $3, 'pending')
    ON CONFLICT (id) DO UPDATE SET state='pending', payload_json=EXCLUDED.payload_json, next_run_at=now(), last_error=NULL
  `, [id, workspaceId, { subject_type: subjectType, subject_id: subjectId, extraction_version: extractionVersion }]);
}

export async function claimJob(db: Database): Promise<Job | null> {
  const result = await db.query<Job>(`UPDATE alpha_sync_jobs SET state='running', attempts=attempts+1 WHERE id=(SELECT id FROM alpha_sync_jobs WHERE provider='extraction' AND state IN ('pending','failed') AND next_run_at <= now() ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,workspace_id,provider,payload_json`);
  return result.rows[0] ?? null;
}

export async function completeJob(db: Database, id: string): Promise<void> { await db.query(`UPDATE alpha_sync_jobs SET state='succeeded', last_error=NULL WHERE id=$1`, [id]); }
export async function failJob(db: Database, id: string, error: unknown): Promise<void> { await db.query(`UPDATE alpha_sync_jobs SET state='failed', last_error=$2, next_run_at=now()+interval '1 minute' WHERE id=$1`, [id, String(error).slice(0, 2_000)]); }

export async function extractJob(db: Database, job: Job, config: ExtractionConfig): Promise<void> {
  if (!config.apiKey) { console.warn("Extraction skipped: No API key configured"); return; }
  const subjectType = z.enum(["source_record", "agent_session"]).parse(job.payload_json["subject_type"]);
  const subjectId = z.string().uuid().parse(job.payload_json["subject_id"]);
  const version = z.string().min(1).parse(job.payload_json["extraction_version"]);
  const subject = subjectType === "source_record"
    ? (await db.query<{ content: string; repository_id: string | null; event_at: Date }>(`SELECT content, repository_id, event_at FROM source_records WHERE id=$1 AND workspace_id=$2`, [subjectId, job.workspace_id])).rows[0]
    : (await db.query<{ summary_json: Record<string, unknown>; repository_id: string; completed_at: Date | null; started_at: Date }>(`SELECT summary_json, repository_id, completed_at, started_at FROM agent_sessions WHERE id=$1 AND workspace_id=$2`, [subjectId, job.workspace_id])).rows[0];
  if (!subject) throw new Error(`Extraction subject not found: ${subjectId}`);
  const content = "content" in subject ? subject.content : JSON.stringify(subject.summary_json);
  const repositoryId = subject.repository_id;
  const eventAt = "event_at" in subject ? subject.event_at : subject.completed_at ?? subject.started_at;
  const prompt = `Extract durable engineering memories from the input. Return strict JSON only as {"memories":[...]}. Each memory must contain memory_type, content, confidence, status, and optional work_thread_id. Allowed memory_type values: decision, requirement, problem, failed_attempt, progress, outcome, unfinished_work. Allowed status values: active, superseded, completed, unknown. Do not add other fields.\n\nInput:\n${content}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await (config.fetch ?? fetch)(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }), signal: controller.signal });
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (!response.ok) throw new Error(`LLM extraction failed: ${body.error?.message ?? response.status}`);
    const extracted = MemoryExtractionSchema.parse(JSON.parse(body.choices?.[0]?.message?.content ?? ""));
    await db.query("BEGIN");
    try {
      for (const memory of extracted.memories) {
        const memoryId = stableUuid(`memory:${subjectType}:${subjectId}:${version}:${memory.memory_type}:${memory.content}`);
        await db.query(`INSERT INTO memories (id, workspace_id, memory_type, content, repository_id, work_thread_id, confidence, status, event_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET content=EXCLUDED.content, confidence=EXCLUDED.confidence, status=EXCLUDED.status, work_thread_id=EXCLUDED.work_thread_id`, [memoryId, job.workspace_id, memory.memory_type, memory.content, repositoryId, memory.work_thread_id ?? null, memory.confidence, memory.status, eventAt]);
        await db.query(`INSERT INTO memory_sources (memory_id, source_record_id, agent_session_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [memoryId, subjectType === "source_record" ? subjectId : null, subjectType === "agent_session" ? subjectId : null]);
      }
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; }
  } finally { clearTimeout(timer); }
}

export async function runOnce(db: Database, config: ExtractionConfig): Promise<boolean> {
  const job = await claimJob(db);
  if (!job) return false;
  try { await extractJob(db, job, config); await completeJob(db, job.id); }
  catch (error) { console.error(`Extraction failed: ${error instanceof Error ? error.message : String(error)}`); await failJob(db, job.id, error); }
  return true;
}

export function startWorkerLoop(db: Database, config: ExtractionConfig, intervalMs = 5_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const poll = async () => {
    try { while (!stopped && await runOnce(db, config)) {} }
    catch (error) { console.error(`Worker poll failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!stopped) timer = setTimeout(poll, intervalMs);
  };
  void poll();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const config = loadConfig();
  const db = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  runOnce(db, { apiKey: config.OPENROUTER_API_KEY, model: config.OPENROUTER_MODEL, baseUrl: config.OPENROUTER_BASE_URL, timeoutMs: config.OPENROUTER_TIMEOUT_MS, extractionVersion: config.EXTRACTION_VERSION }).finally(() => db.end());
}
