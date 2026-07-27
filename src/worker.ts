import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createDatabase, type Database } from "./db.js";

export interface Job { id: string; workspace_id: string; provider: string; payload_json: Record<string, unknown>; }

export function projectSlackIntent(text: string): Array<{ type: string; text: string }> {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((text, index) => ({ type: index === 0 ? "requirement" : /\b(failed|does not work|blocked)\b/i.test(text) ? "failed_attempt" : "progress", text }));
}

export async function claimJob(db: Database): Promise<Job | null> {
  const result = await db.query<Job>(`UPDATE alpha_sync_jobs SET state='running', attempts=attempts+1 WHERE id=(SELECT id FROM alpha_sync_jobs WHERE state IN ('pending','failed') AND next_run_at <= now() ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,workspace_id,provider,payload_json`);
  return result.rows[0] ?? null;
}

export async function completeJob(db: Database, id: string): Promise<void> { await db.query(`UPDATE alpha_sync_jobs SET state='succeeded' WHERE id=$1`, [id]); }
export async function failJob(db: Database, id: string, error: unknown): Promise<void> { await db.query(`UPDATE alpha_sync_jobs SET state='failed', last_error=$2, next_run_at=now()+interval '1 minute' WHERE id=$1`, [id, String(error).slice(0, 2_000)]); }

export async function runOnce(db: Database): Promise<boolean> {
  const job = await claimJob(db);
  if (!job) return false;
  try { await completeJob(db, job.id); } catch (error) { await failJob(db, job.id, error); }
  return true;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const config = loadConfig();
  const db = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  runOnce(db).finally(() => db.end());
}
