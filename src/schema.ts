import { check, foreignKey, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const workspaces = pgTable("workspaces", {
  id: uuid().primaryKey(),
  name: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const connectorConnections = pgTable("connector_connections", {
  id: uuid().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: text({ enum: ["github", "slack", "linear"] }).notNull(),
});

export const sourceRecords = pgTable("source_records", {
  id: uuid().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  connectorConnectionId: uuid("connector_connection_id").references(() => connectorConnections.id, { onDelete: "set null" }),
  sourceType: text("source_type", { enum: ["agent", "slack", "github", "linear"] }).notNull(),
  externalId: text("external_id").notNull(),
  entityKey: text("entity_key"),
  providerEventId: text("provider_event_id"),
  contentHash: text("content_hash"),
  repositoryId: text("repository_id"),
  parentRecordId: uuid("parent_record_id"),
  recordType: text("record_type").notNull(),
  content: text().notNull(),
  author: text(),
  sourceUrl: text("source_url"),
  eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
  providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  foreignKey({ columns: [table.parentRecordId], foreignColumns: [table.id] }).onDelete("set null"),
  uniqueIndex("source_records_external_id_unique").on(table.workspaceId, table.sourceType, table.externalId),
  index("source_records_lookup").on(table.workspaceId, table.repositoryId, table.eventAt),
  uniqueIndex("source_records_provider_event_unique").on(table.workspaceId, table.sourceType, table.providerEventId),
  index("source_records_entity_versions").on(table.workspaceId, table.sourceType, table.entityKey, table.providerUpdatedAt, table.eventAt),
]);

export const workThreads = pgTable("work_threads", {
  id: uuid().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  linearIssueKey: text("linear_issue_key").notNull(),
  title: text().notNull(),
  repositoryId: text("repository_id"),
  status: text({ enum: ["active", "blocked", "completed", "archived"] }).notNull().default("active"),
  version: integer().notNull().default(1),
  linkUrls: text("link_urls").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("work_threads_linear_key_unique").on(table.workspaceId, table.linearIssueKey)]);

export const workThreadEvidence = pgTable("work_thread_evidence", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  workThreadId: uuid("work_thread_id").notNull().references(() => workThreads.id, { onDelete: "cascade" }),
  sourceRecordId: uuid("source_record_id").notNull().references(() => sourceRecords.id, { onDelete: "cascade" }),
  linkReason: text("link_reason", { enum: ["linear_root", "explicit_url", "explicit_key", "agent_outcome", "human"] }).notNull(),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("work_thread_evidence_unique").on(table.workThreadId, table.sourceRecordId)]);

export const claims = pgTable("claims", {
  id: uuid().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  workThreadId: uuid("work_thread_id").notNull().references(() => workThreads.id, { onDelete: "cascade" }),
  sourceRecordId: uuid("source_record_id").notNull().references(() => sourceRecords.id, { onDelete: "cascade" }),
  claimType: text("claim_type", { enum: ["requirement", "constraint", "decision", "attempt", "fact", "outcome"] }).notNull(),
  content: text().notNull(),
  status: text({ enum: ["active", "conflicting", "resolved", "superseded"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("claims_source_type_unique").on(table.workThreadId, table.sourceRecordId, table.claimType)]);

export const agentSessions = pgTable("agent_sessions", {
  id: uuid().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  externalSessionId: text("external_session_id").notNull(),
  agentType: text("agent_type", { enum: ["codex", "claude-code"] }).notNull(),
  repositoryId: text("repository_id").notNull(),
  branch: text(),
  summary: jsonb("summary_json").$type<Record<string, unknown>>(),
  status: text().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [uniqueIndex("agent_sessions_external_id_unique").on(table.workspaceId, table.externalSessionId)]);

export const memories = pgTable("memories", {
  id: uuid().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  memoryType: text("memory_type", { enum: ["decision", "requirement", "problem", "failed_attempt", "progress", "outcome", "unfinished_work"] }).notNull(),
  content: text().notNull(),
  repositoryId: text("repository_id"),
  workThreadId: text("work_thread_id"),
  confidence: real().notNull(),
  status: text({ enum: ["active", "superseded", "completed", "unknown"] }).notNull().default("unknown"),
  eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("memories_confidence_check", sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
  index("memories_lookup").on(table.workspaceId, table.repositoryId, table.status, table.eventAt),
]);

export const memorySources = pgTable("memory_sources", {
  memoryId: uuid("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, { onDelete: "cascade" }),
  agentSessionId: uuid("agent_session_id").references(() => agentSessions.id, { onDelete: "set null" }),
}, (table) => [
  check("memory_sources_has_source_check", sql`${table.sourceRecordId} IS NOT NULL OR ${table.agentSessionId} IS NOT NULL`),
  uniqueIndex("memory_sources_record_unique").on(table.memoryId, table.sourceRecordId),
  uniqueIndex("memory_sources_session_unique").on(table.memoryId, table.agentSessionId),
]);
