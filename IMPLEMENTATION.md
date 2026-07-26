# Termyte Cloud Implementation

## Purpose

This repository is the shared context control plane. It receives organizational
signals and coding-agent activity, keeps each piece of work in one live Work
Thread, and returns the smallest relevant Context Briefing when an agent starts
working.

Cloud owns shared state, permissions, provenance, receipts, and the dashboard.
It does not run coding agents.

## Product contract

The first sellable workflow is:

```text
Slack report
  -> Work Thread
  -> fresh coding agent receives intent
  -> agent execution updates Work Thread
  -> next coding agent receives the updated state
```

The first demo uses Slack as the organizational source. GitHub and Linear remain
valid later sources, but they are not required to prove the core loop.

## Current implementation

Already present and tested:

- PostgreSQL schema and ordered migrations;
- workspace, membership, agent identity, credential, and grant models;
- device authorization backend and browser approval route;
- Slack signature verification and replay-window checks;
- Slack bot/subtype filtering;
- repository-scoped connector mappings;
- deterministic Slack intent projection into objective, observation,
  constraint, expected result, and failure items;
- Work Thread creation and source provenance;
- context resolution, abstention, clarification, and repository filtering;
- Context Briefings and immutable Context Receipts;
- authenticated agent event ingestion and durable projection jobs;
- immutable, timestamped Source Event versions with source-level deduplication;
- full Slack-thread snapshots rather than individual Slack message events;
- a dashboard for Work Threads, agents, receipts, sources, and corrections;
- an explicit local demo login mode controlled by `DEMO_USER_ID`;
- demo seed and signed Slack-event commands.

Still requiring end-to-end hardening:

- production Slack OAuth and event subscription setup;
- repeatable real-agent device authorization;
- clear live display of agent actions, tests, and final result;
- automatic or one-click dashboard refresh during recording;
- production deployment and secret configuration;
- database-backed tests in CI rather than skipped local tests.

## Core data model

### Work Thread

The durable unit of active work:

- title;
- objective;
- current state;
- repository;
- status and version;
- agent grants.

### Context Item

A typed fact attached to a Work Thread:

- objective;
- observation;
- constraint;
- decision;
- attempt or failure;
- expected result;
- evidence;
- outcome.

Every delivered item must point to at least one source event.

### Source Event

An immutable input from:

- Slack, GitHub, or Linear;
- Codex, Claude Code, or OpenCode.

Source Events are immutable versions. Each keeps provider occurrence and server
receipt timestamps. A Source Entity points to the newest version used for
current extraction, while older versions remain available for audit.

### Context Receipt

The audit record for one briefing:

- request text;
- selected Work Thread;
- Work Thread version;
- included items and source snapshots;
- receiving agent identity;
- delivery and acknowledgement times.

## Implementation sequence

### 1. Slack intake

1. verify the raw request signature and timestamp;
2. ignore bot and unrelated subtype noise while accepting thread edits;
3. require an administrator-selected channel mapping;
4. redact sensitive values;
5. fetch and store the complete Slack thread as one immutable Source Event;
6. find or create the repository's Work Thread;
7. enqueue projection.

For the demo, split a short Slack report using deterministic rules:

- first line -> objective;
- statements describing current behavior -> observation;
- `without`, `must not`, or similar wording -> constraint;
- desired behavior -> expected result;
- failed approaches -> failure.

This rule-based projection is intentionally narrow. Replace it with evaluated
model-assisted synthesis only after real reports show that the rules are
insufficient.

Acceptance:

- one Slack message creates one correctly titled Work Thread;
- replaying the webhook creates no duplicate;
- bot messages create nothing;
- all projected items retain Slack provenance.

### 2. Context resolution

Resolve only among:

- active Work Threads;
- the current repository;
- Work Threads granted to the requesting agent;
- context items allowed for that agent.

Rank using exact work/handoff IDs, recent participation, lexical overlap, and
repository scope. Abstain below the confidence threshold and ask for
clarification when two candidates are too close.

Acceptance:

- `Fix that auth bug.` resolves the correct auth Work Thread;
- an unrelated repository cannot receive it;
- a revoked or restricted agent receives no context;
- a repeated idempotency key returns the same result.

### 3. Context delivery and receipts

Build a bounded briefing ordered by operational importance:

1. constraints;
2. decisions and blockers;
3. failures;
4. expected results;
5. evidence and current state;
6. observations.

Store the exact selected items and source snapshots before returning the
briefing.

Acceptance:

- the response remains inside its token budget;
- the dashboard shows what was sent and why;
- delivery remains auditable after source content changes.

### 4. Agent execution updates

Accept authenticated batches from the runtime. Verify that:

- event platform matches the credential's agent identity;
- the agent has append permission for the Work Thread;
- the session is bound to the credential and device;
- duplicate external event IDs are ignored.

Project events into active Work Thread state. A final response becomes an
outcome and completes any claimed handoff.

Acceptance:

- terminal failures appear as failures;
- successful commands and files touched appear as evidence or observations;
- the final response and test result appear before the next agent resolves;
- Work Thread version increases once per projection.

### 5. Dashboard

The recording surface must show:

- Work Thread title and status;
- original Slack source;
- goal, constraints, failed attempt, and expected result;
- Context Receipts for Codex and Claude Code;
- agent actions and test evidence;
- final outcome.

Keep corrections and restrictions available, but hide billing and unused
connectors from the demo path.

### 6. Security

- use Supabase human authentication in production;
- allow `DEMO_USER_ID` only on a local recording deployment;
- hash agent secrets with the server pepper;
- encrypt connector credentials;
- verify every webhook over the raw body;
- redact at ingestion;
- enforce workspace and agent grants in SQL-backed operations;
- never log credentials, prompt bodies, or briefing contents.

### 7. Scalability

The current API/worker/PostgreSQL split is sufficient for the first customers:

- API processes remain stateless;
- projection work is queued;
- workers claim jobs with `FOR UPDATE SKIP LOCKED`;
- source events and receipts are append-heavy;
- indexes scope retrieval by workspace, Work Thread, state, and repository.

Scale by adding API and worker replicas before introducing another datastore.
Add embeddings or a separate search system only when PostgreSQL retrieval is
measurably insufficient.

## Deployment gate

- run migrations against an empty PostgreSQL database;
- run the full type check, tests, and build;
- run database tests with `DATABASE_URL`;
- confirm `/health`;
- confirm API and worker share the same pepper and database;
- configure Slack callback and signing secret;
- disable demo mode;
- configure Supabase authentication;
- verify one device flow and one real Context Receipt.

## Not in the demo build

- autonomous orchestration;
- agent scheduling;
- broad company search;
- meeting ingestion;
- sales or support agents;
- a general knowledge graph;
- model training or complex semantic infrastructure.

The demo is done when one Work Thread remains coherent from Slack intent through
two coding-agent sessions.
