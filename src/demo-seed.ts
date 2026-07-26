import { randomUUID } from "node:crypto";
import { createAgentCredential, createAgentIdentity, createWorkspace } from "./admin.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { connectorKey, encryptCredentials } from "./connectors.js";

const USER_ID = process.env.DEMO_USER_ID ?? "00000000-0000-4000-8000-000000000001";
const SLACK_TEAM = process.env.DEMO_SLACK_TEAM ?? "T-DEMO";
const SLACK_CHANNEL = process.env.DEMO_SLACK_CHANNEL ?? "C-DEMO";
const REPOSITORY = process.env.DEMO_REPOSITORY ?? "github.com/termyte/demo-auth";
const SLACK_BOT_TOKEN = process.env.DEMO_SLACK_BOT_TOKEN;
if (!SLACK_BOT_TOKEN) throw new Error("DEMO_SLACK_BOT_TOKEN is required");
const SCOPES = [
  "events:write",
  "context:read",
  "outcomes:write",
  "handoffs:create",
  "handoffs:claim",
] as const;

const config = loadConfig({ ...process.env, DEMO_USER_ID: USER_ID });
if (!config.CONNECTOR_ENCRYPTION_KEY) throw new Error("CONNECTOR_ENCRYPTION_KEY is required");
const db = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);

try {
  await db.query(`DELETE FROM workspaces WHERE slug = 'termyte-demo'`);
  const workspace = await createWorkspace(db, USER_ID, {
    name: "Acme",
    slug: "termyte-demo",
  });
  const codex = await createAgentIdentity(db, USER_ID, workspace.id, {
    name: "Codex",
    kind: "codex",
  });
  const claude = await createAgentIdentity(db, USER_ID, workspace.id, {
    name: "Claude Code",
    kind: "claude-code",
  });
  const codexCredential = await createAgentCredential(db, config.AGENT_TOKEN_PEPPER, USER_ID, workspace.id, {
    agentIdentityId: codex.id,
    scopes: [...SCOPES],
  });
  const claudeCredential = await createAgentCredential(db, config.AGENT_TOKEN_PEPPER, USER_ID, workspace.id, {
    agentIdentityId: claude.id,
    scopes: [...SCOPES],
  });
  const connectorId = randomUUID();
  await db.query(`
    INSERT INTO connector_connections (
      id, workspace_id, provider, name, external_account_id,
      credentials_ciphertext, selected_scopes, created_by_user_id
    ) VALUES ($1, $2, 'slack', 'Demo Slack', $3, $4, $5, $6)
  `, [
    connectorId,
    workspace.id,
    SLACK_TEAM,
    encryptCredentials(connectorKey(config.CONNECTOR_ENCRYPTION_KEY), {
      access_token: SLACK_BOT_TOKEN,
    }),
    JSON.stringify([SLACK_CHANNEL]),
    USER_ID,
  ]);
  await db.query(`
    INSERT INTO connector_scope_mappings (
      id, workspace_id, connector_connection_id, external_scope_id,
      external_scope_name, repository_key, created_by_user_id
    ) VALUES ($1, $2, $3, $4, '#customer-bugs', $5, $6)
  `, [randomUUID(), workspace.id, connectorId, SLACK_CHANNEL, REPOSITORY, USER_ID]);

  process.stdout.write(`${JSON.stringify({
    workspace_id: workspace.id,
    demo_user_id: USER_ID,
    repository: REPOSITORY,
    slack_team: SLACK_TEAM,
    slack_channel: SLACK_CHANNEL,
    codex_credential: codexCredential.token,
    claude_credential: claudeCredential.token,
  }, null, 2)}\n`);
} finally {
  await db.end();
}
