import type { Database } from "./db.js";

const buckets = new Map<string, { started: number; count: number }>();

export async function consumeRateLimit(_db: Database, identity: string, limit: number, windowSeconds: number): Promise<boolean> {
  const now = Date.now();
  const bucket = buckets.get(identity);
  if (!bucket || now - bucket.started >= windowSeconds * 1_000) {
    buckets.set(identity, { started: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}
