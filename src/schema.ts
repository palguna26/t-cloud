import { check, foreignKey, index, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const workspaces = pgTable("workspaces", {
  id: uuid().primaryKey(),
  name: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sourceRecords = pgTable("source_records", {
  id: uuid().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sourceType: text("source_type", { enum: ["slack", "github"] }).notNull(),
  externalId: text("external_id").notNull(),
  repositoryId: text("repository_id"),
  parentRecordId: uuid("parent_record_id"),
  recordType: text("record_type").notNull(),
  content: text().notNull(),
  author: text(),
  sourceUrl: text("source_url"),
  eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  foreignKey({ columns: [table.parentRecordId], foreignColumns: [table.id] }).onDelete("set null"),
  uniqueIndex("source_records_external_id_unique").on(table.workspaceId, table.sourceType, table.externalId),
  index("source_records_lookup").on(table.workspaceId, table.repositoryId, table.eventAt),
]);

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
