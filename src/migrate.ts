import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, type Database } from "./db.js";
import { loadConfig } from "./config.js";

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrate(db: Database): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('termyte_schema_migrations'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const known = new Set((await client.query<{ name: string }>(
      `SELECT name FROM schema_migrations`,
    )).rows.map((row) => row.name));
    for (const name of ["001_alpha.sql", "002_target_schema.sql", "003_source_providers.sql", "004_linear_connector.sql", "005_work_threads.sql", "006_connector_tenant_safety.sql"]) {
      if (known.has(name)) continue;
      await client.query(readFileSync(join(migrationDirectory, name), "utf8"));
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [name]);
      applied.push(name);
    }
    return applied;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('termyte_schema_migrations'))`);
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
