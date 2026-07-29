import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { NormalizedConnectorEvent } from "./connectors.js";

const LINEAR_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;
const URL = /https?:\/\/[^\s<>()]+/g;

export function linearKey(text: string): string | null {
  return text.match(LINEAR_KEY)?.[0] ?? null;
}

export async function linkConnectorEvidence(client: pg.PoolClient, workspaceId: string, sourceRecordId: string, event: NormalizedConnectorEvent, content: string): Promise<string | null> {
  if (event.provider === "linear") {
    const key = linearKey(event.entityKey) ?? linearKey(content);
    if (!key) return null;
    const links = [...new Set(content.match(URL) ?? [])];
    const thread = (await client.query<{ id: string }>("INSERT INTO work_threads (id,workspace_id,linear_issue_key,title,repository_id,link_urls) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id,linear_issue_key) DO UPDATE SET title=excluded.title,repository_id=COALESCE(excluded.repository_id,work_threads.repository_id),link_urls=ARRAY(SELECT DISTINCT unnest(work_threads.link_urls || excluded.link_urls)),updated_at=now() RETURNING id", [randomUUID(), workspaceId, key, event.title, event.repositoryKey ?? null, links])).rows[0]!;
    await attach(client, thread.id, sourceRecordId, "linear_root", event, content);
    const linked = await client.query<{ id: string }>("SELECT id FROM source_records WHERE workspace_id=$1 AND id<>$2 AND (source_url=ANY($3::text[]) OR content ILIKE $4)", [workspaceId, sourceRecordId, links, `%${key}%`]);
    for (const row of linked.rows) await attachExisting(client, thread.id, row.id, links.length ? "explicit_url" : "explicit_key");
    return thread.id;
  }
  const key = linearKey(content);
  const thread = (await client.query<{ id: string }>("SELECT id FROM work_threads WHERE workspace_id=$1 AND (($2::text IS NOT NULL AND linear_issue_key=$2) OR ($3::text IS NOT NULL AND $3=ANY(link_urls))) ORDER BY updated_at DESC LIMIT 1", [workspaceId, key, event.canonicalUrl ?? null])).rows[0];
  if (!thread) return null;
  await attach(client, thread.id, sourceRecordId, key ? "explicit_key" : "explicit_url", event, content);
  return thread.id;
}

export async function attachAgentOutcome(client: pg.PoolClient, workThreadId: string, sourceRecordId: string, content: string): Promise<void> {
  await attachExisting(client, workThreadId, sourceRecordId, "agent_outcome");
  await client.query("INSERT INTO claims (id,workspace_id,work_thread_id,source_record_id,claim_type,content) SELECT $1,workspace_id,id,$2,'outcome',$3 FROM work_threads WHERE id=$4 ON CONFLICT (work_thread_id,source_record_id,claim_type) DO NOTHING", [randomUUID(), sourceRecordId, content, workThreadId]);
}

async function attach(client: pg.PoolClient, workThreadId: string, sourceRecordId: string, reason: "linear_root" | "explicit_url" | "explicit_key", event: NormalizedConnectorEvent, content: string): Promise<void> {
  await attachExisting(client, workThreadId, sourceRecordId, reason);
  await client.query("INSERT INTO claims (id,workspace_id,work_thread_id,source_record_id,claim_type,content) SELECT $1,workspace_id,id,$2,$3,$4 FROM work_threads WHERE id=$5 ON CONFLICT (work_thread_id,source_record_id,claim_type) DO NOTHING", [randomUUID(), sourceRecordId, claimType(event), content, workThreadId]);
}

async function attachExisting(client: pg.PoolClient, workThreadId: string, sourceRecordId: string, reason: "linear_root" | "explicit_url" | "explicit_key" | "agent_outcome" | "human"): Promise<void> {
  const result = await client.query("INSERT INTO work_thread_evidence (work_thread_id,source_record_id,link_reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [workThreadId, sourceRecordId, reason]);
  if (result.rowCount === 1) {
    await client.query("UPDATE work_threads SET version=version+1,updated_at=now() WHERE id=$1", [workThreadId]);
    await client.query("INSERT INTO claims (id,workspace_id,work_thread_id,source_record_id,claim_type,content) SELECT $1,wt.workspace_id,wt.id,sr.id,CASE WHEN sr.record_type='outcome' THEN 'outcome' WHEN sr.source_type='linear' THEN 'requirement' WHEN sr.source_type='slack' THEN 'constraint' WHEN sr.source_type='github' THEN 'attempt' ELSE 'fact' END,sr.content FROM work_threads wt JOIN source_records sr ON sr.id=$2 AND sr.workspace_id=wt.workspace_id WHERE wt.id=$3 ON CONFLICT (work_thread_id,source_record_id,claim_type) DO NOTHING", [randomUUID(), sourceRecordId, workThreadId]);
  }
}

function claimType(event: NormalizedConnectorEvent): "requirement" | "constraint" | "decision" | "attempt" | "fact" {
  if (event.provider === "linear") return "requirement";
  if (event.eventType === "constraint") return "constraint";
  if (event.eventType === "decision") return "decision";
  if (event.eventType === "failure") return "attempt";
  return event.provider === "slack" ? "constraint" : event.provider === "github" ? "attempt" : "fact";
}
