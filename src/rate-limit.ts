import { createHash } from "node:crypto";
import type { Database } from "./db.js";

export async function consumeRateLimit(
  db: Database,
  identity: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const key = createHash("sha256").update(identity).digest("hex");
  const result = await db.query<{ request_count: number }>(`
    INSERT INTO rate_limit_buckets (key, window_started_at, request_count)
    VALUES ($1, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      request_count = CASE
        WHEN rate_limit_buckets.window_started_at <= now() - make_interval(secs => $2)
          THEN 1
        ELSE rate_limit_buckets.request_count + 1
      END,
      window_started_at = CASE
        WHEN rate_limit_buckets.window_started_at <= now() - make_interval(secs => $2)
          THEN now()
        ELSE rate_limit_buckets.window_started_at
      END
    RETURNING request_count
  `, [key, windowSeconds]);
  return result.rows[0]!.request_count <= limit;
}
