import { createHash } from "node:crypto";
import pg from "pg";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const workspaceId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000002";
const agentId = "30000000-0000-4000-8000-000000000003";
const tokenPrefix = "0123456789abcdef01";
const secret = "a".repeat(43);

try {
  if (process.argv[2] === "setup") {
    await db.query("DELETE FROM workspaces");
    await db.query("INSERT INTO workspaces (id,name,slug,owner_user_id) VALUES ($1,'E2E','e2e',$2)", [workspaceId, userId]);
    await db.query("INSERT INTO agent_identities (id,workspace_id,name,kind,created_by_user_id) VALUES ($1,$2,'E2E Agent','codex',$3)", [agentId, workspaceId, userId]);
    await db.query("INSERT INTO agent_credentials (id,workspace_id,agent_identity_id,token_prefix,secret_hash,scopes,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", ["40000000-0000-4000-8000-000000000004", workspaceId, agentId, tokenPrefix, createHash("sha256").update(secret).update(process.env.AGENT_TOKEN_PEPPER).digest(), ["context:read"], userId]);
    await db.query("INSERT INTO connector_connections (id,workspace_id,provider,name,external_account_id,created_by_user_id) VALUES ($1,$2,'github','E2E GitHub','12345',$3),($4,$2,'slack','E2E Slack','T123',$3)", ["50000000-0000-4000-8000-000000000005", workspaceId, userId, "60000000-0000-4000-8000-000000000006"]);
    await db.query("INSERT INTO memories (id,workspace_id,memory_type,content,repository_id,confidence,status,event_at) VALUES ($1,$2,'problem','Fix the bug reported in issue 123','owner/repo',1,'active',now())", ["70000000-0000-4000-8000-000000000007", workspaceId]);
  } else if (process.argv[2] === "verify") {
    const { rows } = await db.query("SELECT source_type,count(*)::int AS count FROM source_records GROUP BY source_type");
    for (const source of ["github", "slack"]) if (rows.find((row) => row.source_type === source)?.count !== 1) throw new Error(`Expected one ${source} source_record`);
    process.stdout.write("Webhook records verified in Postgres.\n");
  } else throw new Error("Usage: node scripts/e2e-db.mjs setup|verify");
} finally {
  await db.end();
}
