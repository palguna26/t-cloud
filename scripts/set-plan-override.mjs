import { randomUUID } from "node:crypto";
import pg from "pg";

const [workspaceId, plan, expiresAt = "", ...noteParts] = process.argv.slice(2);
const note = noteParts.join(" ").trim();
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId ?? "")) {
  throw new Error("workspace_id must be a UUID");
}
if (!["founding_partner", "internal", "clear"].includes(plan ?? "")) {
  throw new Error("plan must be founding_partner, internal, or clear");
}
const expires = expiresAt && expiresAt !== "-"
  ? new Date(expiresAt)
  : null;
if (expires && Number.isNaN(expires.getTime())) throw new Error("expires_at must be an ISO date or -");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const updated = await client.query(`
    UPDATE workspaces
    SET plan_override = $2,
      plan_override_expires_at = $3,
      plan_override_note = $4
    WHERE id = $1
    RETURNING id, plan_override, plan_override_expires_at, plan_override_note
  `, [
    workspaceId,
    plan === "clear" ? null : plan,
    plan === "clear" ? null : expires,
    plan === "clear" ? null : note || null,
  ]);
  if (!updated.rows[0]) throw new Error("workspace not found");
  await client.query(`
    INSERT INTO audit_events (
      id, workspace_id, actor_type, actor_id, action,
      target_type, target_id, metadata_json
    ) VALUES ($1, $2, 'operator', 'plan-override-cli', 'billing.plan_override',
      'workspace', $4, $3)
  `, [randomUUID(), workspaceId, updated.rows[0], workspaceId]);
  await client.query("COMMIT");
  process.stdout.write(`${JSON.stringify(updated.rows[0])}\n`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
