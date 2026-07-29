import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { createDatabase, type Database } from "./db.js";
import { loadConfig } from "./config.js";

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const migrations = ["001_alpha.sql", "002_target_schema.sql", "003_source_providers.sql", "004_linear_connector.sql", "005_work_threads.sql", "006_connector_tenant_safety.sql"];

async function reconcileLegacySchema(client: PoolClient): Promise<void> {
  const checks = [
    `SELECT to_regclass('workspaces') IS NOT NULL AND to_regclass('agent_credentials') IS NOT NULL AND to_regclass('connector_connections') IS NOT NULL AND to_regclass('alpha_receipts') IS NOT NULL AND to_regclass('audit_events') IS NOT NULL AND (to_regclass('alpha_source_records') IS NOT NULL OR to_regclass('source_records') IS NOT NULL) AS ready`,
    `SELECT to_regclass('source_records') IS NOT NULL AND to_regclass('agent_sessions') IS NOT NULL AND to_regclass('memories') IS NOT NULL AND to_regclass('memory_sources') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='source_records' AND column_name='source_type') AS ready`,
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='source_records_source_type_check' AND pg_get_constraintdef(oid) LIKE '%linear%') AS ready`,
    `SELECT count(*) = 2 AS ready FROM pg_constraint WHERE conname IN ('connector_connections_provider_check','connector_oauth_states_provider_check') AND pg_get_constraintdef(oid) LIKE '%linear%'`,
    `SELECT to_regclass('work_threads') IS NOT NULL AND to_regclass('work_thread_evidence') IS NOT NULL AND to_regclass('claims') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='source_records' AND column_name='connector_connection_id') AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='alpha_receipts' AND column_name='work_thread_id') AS ready`,
    `SELECT to_regclass('connector_active_account_unique') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='work_thread_evidence' AND column_name='workspace_id') AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='claims_workspace_thread_fk') AS ready`,
  ];
  for (let index = 0; index < checks.length; index += 1) {
    const ready = (await client.query<{ ready: boolean }>(checks[index]!)).rows[0]?.ready;
    if (!ready) break;
    await client.query(`INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [migrations[index]]);
  }
}

export async function migrate(db: Database): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    if ((await client.query(`SELECT 1 FROM schema_migrations LIMIT 1`)).rowCount === 0) {
      await reconcileLegacySchema(client);
    }
    const known = new Set((await client.query<{ name: string }>(
      `SELECT name FROM schema_migrations`,
    )).rows.map((row) => row.name));
    for (const name of migrations) {
      if (known.has(name)) continue;
      await client.query(readFileSync(join(migrationDirectory, name), "utf8"));
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [name]);
      applied.push(name);
    }
    return applied;
  } finally {
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  const db = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  migrate(db)
    .then((applied) => process.stdout.write(
      applied.length ? `Applied: ${applied.join(", ")}\n` : "Database is up to date.\n",
    ))
    .finally(() => db.end());
}
