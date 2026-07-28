# Unified Termyte Cloud Context Platform

## Goal

Termyte Cloud collects selected engineering data from coding agents, Slack,
GitHub, Linear, and Jira. It stores immutable source history, extracts durable
context through OpenRouter, and delivers only relevant, source-linked context
to Codex and Claude Code through the Termyte protocol v3 connector.

## Deployment architecture

The first version uses one Render web service and one Supabase PostgreSQL
database. The Node.js service runs:

- the Hono HTTP API and dashboard;
- server-side Supabase authentication;
- OAuth callbacks and signed webhook receivers;
- a PostgreSQL-backed job queue and in-process job loop;
- historical connector imports;
- OpenRouter extraction; and
- context retrieval and Termyte protocol v3 endpoints.

PostgreSQL preserves all jobs across deploys and restarts. A separate worker is
deferred until imports or extraction need independent scaling.

## Authentication and onboarding

Supabase provides email registration, email confirmation, login, password
reset, session refresh, and logout. The browser calls Termyte Cloud rather than
Supabase directly. Termyte stores sessions in `HttpOnly`, `Secure`,
`SameSite=Lax` cookies. No Supabase configuration or keys are exposed through
browser assets or `/app-config.json`. State-changing browser requests also
require CSRF protection.

After registration, a user can create a workspace or request to join one.
Joining through either a workspace code or invite link creates a pending
request. An owner or admin must approve it. Workspace codes and invite links
are random, expiring, revocable, and auditable.

Roles are:

- owner: full control, workspace ownership, and permanent deletion;
- admin: memberships, connectors, imports, mappings, and agent management;
- member: dashboard access and coding-agent usage.

All reads and writes are scoped to an approved workspace membership.

## Coding-agent connection

`termyte connect` uses protocol v3 device authorization:

1. The CLI requests a short-lived device code.
2. It prints a secure URL containing the user code.
3. Pressing Enter opens the browser.
4. The user registers or signs in and selects an approved workspace.
5. If the workspace has no compatible identity, Cloud creates one by default.
6. Later connections let the user reuse a compatible identity or create one.
7. Cloud issues a separate revocable device token for the local installation.
8. The CLI stores the token securely and polls until authorization completes.

Only identities matching the client platform, Codex or Claude Code, are shown.
Agent tokens are hashed before database storage.

Agents send events, request context, acknowledge delivered context receipts,
and report outcomes through the existing protocol v3 `/v1/*` boundary. There
is no second custom public agent protocol.

## Connectors

The supported connectors are Slack, GitHub, Linear, and Jira. Only owners and
admins manage connections.

Connection setup requires explicit source selection:

- Slack channels;
- GitHub repositories;
- Linear teams or projects; and
- Jira projects.

Every selected source is mapped to a repository key. The user chooses a 30,
60, or 90-day historical import, with 30 days selected by default. Full and
custom date ranges are deferred. Live signed webhooks collect changes after
connection.

Disconnecting stops imports and webhooks but retains existing data. A separate
permanent-delete action removes connector credentials, mappings, raw source
data, extracted context, and dependent versions. The user must confirm an
explicit warning that deletion cannot be recovered. Minimal audit metadata is
retained without deleted content.

## Ingestion and batching

Incoming webhooks are verified and stored immediately. Historical imports use
provider pagination. Agent protocol events arrive in batches.

Source processing uses stable external identities and idempotency keys.
Duplicate deliveries do not create duplicate history. Changed content creates
an immutable source event linked to the same source entity.

LLM extraction works on small logical batches of at most 20 entities. Each
entity stays separate within the batch. The extraction unit is:

- Slack: a complete thread snapshot;
- GitHub: an issue or pull request with comments and updates;
- Linear: an issue with comments and status history;
- Jira: an issue with comments and status history; and
- agent: a completed session summary with related events.

An updated entity creates a new immutable source version and queues
re-extraction.

## Shared context model

All connectors write to one context schema. A connector extracts only types
that apply to its content. Irrelevant input is not forced into a category.

The taxonomy is:

- Decision
- Requirement
- Problem
- Attempt, with `result: failed | succeeded | inconclusive`
- Work item, with `status: open | blocked | completed | abandoned`
- Progress
- Outcome

Each context item has a stable identity. Changes create immutable context
versions linked to the prior version. Retrieval uses the latest valid version,
while complete history remains available for audit and reprocessing. Every
context version links to its supporting source events.

Raw source records are stored before extraction and are never modified.
OpenRouter is the only extraction provider in the first version. Its model is
selected with `OPENROUTER_MODEL`; its API key remains server-side. Invalid or
failed LLM output creates no context item and never damages raw data.

## Context retrieval

Agent requests include repository, task, branch, and explicit references when
available. Retrieval combines relevant current context from agent sessions,
Slack, GitHub, Linear, and Jira.

Each delivered item includes:

- source connector and original URL or reference;
- source timestamp;
- current version;
- confidence;
- repository mapping; and
- a short reason it is relevant to the task.

Results below a configurable delivery confidence threshold, initially `0.70`,
are excluded. If no reliable items remain, Cloud returns `no_match` with a safe
reason. Low-confidence extractions remain available for later reprocessing but
are not delivered to agents.

## Data model

The target schema contains:

- `users`: references to Supabase users;
- `workspaces` and `workspace_memberships`;
- `workspace_join_requests` and `workspace_invites`;
- `agent_identities` and `device_authorizations`;
- `connector_connections` and `connector_scope_mappings`;
- `source_entities` and append-only `source_events`;
- `context_items` and append-only `context_versions`;
- `context_sources`;
- `context_receipts` and `agent_outcomes`;
- `jobs`; and
- `audit_events`.

Current source and context state is derived from the latest valid version.

## Secret handling

No secret, provider API key, OAuth token, agent token, session token, or
connector credential may appear in HTML, JavaScript assets, API responses,
dashboard state, or logs.

Connector credentials are encrypted with AES-256-GCM. Webhooks require
provider signatures. OAuth state and device codes are short-lived and
single-use. Dashboard responses show only connection status and masked
identifiers. Errors are cleaned before being returned. Logs use explicit token
and secret redaction and never include source content or context packets.

## Reliability

Imports, extraction, reprocessing, and deletion use idempotent PostgreSQL jobs.
Failures retry with bounded delay. Permanent failures stop retrying and appear
in the dashboard. Connector token expiry marks a connection as requiring
attention.

The in-process job loop stops claiming work during graceful shutdown. Active
jobs finish or return to the queue. Restart recovery resumes unfinished work.
Permanent deletion is not repeated after successful completion.

API errors return request IDs without internal details or secrets.

## Verification

Release verification must cover:

- registration, confirmation, login, refresh, logout, and password reset;
- workspace creation, join requests, approvals, roles, and tenant isolation;
- first and repeat device authorization;
- OAuth and encrypted token storage for all four connectors;
- 30, 60, and 90-day imports;
- signed webhooks, pagination, retries, and duplicate delivery handling;
- complete thread and issue snapshot batching;
- stable source identities and immutable source versions;
- shared taxonomy and connector-specific extraction;
- Attempt result and Work item status transitions;
- confidence filtering and `no_match`;
- cross-source retrieval with source references;
- permanent connector deletion;
- queued-job restart recovery;
- secret scanning of browser assets, responses, and logs;
- migrations against a fresh Supabase PostgreSQL database; and
- a hosted end-to-end Termyte run with a real Codex or Claude Code client.

Source tests, builds, database tests, and hosted end-to-end behavior must be
reported separately. None is proof of another.

## Deferred work

- A separate background worker service
- Custom or full-history import ranges
- LLM providers other than OpenRouter
- Independent microservices or external queue infrastructure
