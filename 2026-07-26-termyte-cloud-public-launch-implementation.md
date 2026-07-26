# Termyte Cloud Public Launch Implementation Plan

**Repository:** `C:\Users\Palguna\Desktop\termyte-cloud`  
**Parallel peer plan:** `2026-07-26-termyte-package-public-launch-implementation.md`  
**Design:** `../specs/2026-07-26-cloud-context-control-plane-design.md`

## Goal

Turn the existing Hono/PostgreSQL service into the launch control plane for
GitHub, Slack, shared knowledge, intent-aware retrieval, exact Context Receipts,
agent activity, and the public dashboard. Work Threads remain automatic,
internal correlation state only.

## Scope

### Build

- Protocol v3 consumption and contract drift checks
- Workspace-wide source access confirmation
- Complete GitHub and Slack connector loops
- Immutable raw source storage and deletion
- Gemma 4 27B extraction through Cloudflare Workers AI
- Strict provenance and trust-state validation
- Automatic internal Work Thread correlation
- Explainable task + company intent retrieval
- Confidence-based abstention
- Exact merged Context Receipts
- Session/activity/outcome APIs and views
- Launch dashboard without Work Threads
- PostgreSQL, worker, security, and end-to-end proof

### Do not build

- Public Work Thread APIs or UI
- User clarification or internal-thread selection
- Cursor or Linear launch flows
- Embeddings, pgvector, or learned reranking
- Live Slack/GitHub per-user permission mirroring
- Cloudflare Workers API migration
- New queue or framework
- Keyword rules that create trusted knowledge

## Hard ownership boundary

Cloud owns sources, extraction, internal correlation, intent signals, ranking,
abstention, receipts, activity storage, and dashboard reads. The npm package
owns local context, final merge/render, native injection, and exact delivery
acknowledgement.

Cloud returns structured items, not a final briefing. Cloud must never require
or expose a Work Thread ID in the launch protocol.

## Frozen protocol v3

Set `TERMYTE_PROTOCOL_VERSION = 3`.

Enums:

- platform: `codex | claude-code | opencode`
- task mode: `implement | investigate | review | verify | continue | general`
- trust: `observed | inferred | verified | proposed | conflicting | stale`
- abstention: `low_confidence | no_match | no_authorized_sources | no_indexed_sources`

`POST /v1/context/resolve` request:

```ts
{
  schema_version: 3;
  request_text: string;                  // 1..100000
  agent_session_id: string;
  repository_key: string;
  branch?: string;
  changed_files: string[];               // max 200
  recent_files: string[];                // max 200
  explicit_references: string[];         // max 50
  task_mode_hint?: TaskMode;
  previous_receipt_id?: string;
  cloud_token_budget: number;            // 256..1600
  idempotency_key: string;
}
```

Context response:

```ts
{
  schema_version: 3;
  state: "context";
  receipt_id: string;
  task_mode: TaskMode;
  items: Array<{
    item_id: string;
    type: "fact" | "decision" | "constraint" | "requirement" |
      "attempt" | "discovery" | "open_question" | "outcome" | "evidence";
    text: string;
    status: "observed" | "inferred" | "verified" | "proposed" |
      "conflicting" | "stale";
    confidence: number;                  // 0..1
    task_relevance: number;              // integer 0..100
    company_relevance: number;           // integer 0..100
    task_reason: string;
    company_reason: string;
    source: {
      source_record_id: string;
      provider: "github" | "slack" | "agent";
      title: string;
      url?: string;
      author?: string;
      occurred_at: number;
    };
  }>;
  omitted_count: number;
  expires_at: number;
}
```

Abstention response:

```ts
{
  schema_version: 3;
  state: "abstained";
  receipt_id: string;
  code: "low_confidence" | "no_match" | "no_authorized_sources" |
    "no_indexed_sources";
  message: string;
}
```

`POST /v1/receipts/:id/ack` delivered request:

```ts
{
  schema_version: 3;
  delivery_status: "delivered";
  delivered_at: number;
  final_packet: string;
  final_packet_sha256: string;            // lowercase SHA-256 hex
  local_item_count: number;
  cloud_item_ids: string[];
  idempotency_key: string;
}
```

Failed acknowledgement replaces the delivery fields with
`delivery_status: "failed"` and `failure_code`. Response is
`{ schema_version: 3, acknowledged: true }`.

`POST /v1/events/batch` keeps the existing batch envelope. Each event contains
event ID/type, agent session, occurrence time, platform source, optional
repository, branch, receipt, content, files, and metadata. It contains no
`work_thread_id`.

`POST /v1/outcomes` contains agent session, optional receipt, status, summary,
evidence, reported time, and idempotency key. It contains no `work_thread_id`.

There is no clarification state. Work creation and handoff routes are not
launch APIs.

Vendor the package contract and `test/fixtures/cloud-contract/v3/` with its
manifest. `npm run check:contract` must compare protocol version, fixture bytes,
and SHA-256 hashes. Do not hand-edit the vendored copy.

## Data rules

### Raw sources

- Source Events are immutable versions.
- Source Entities hold mutable head and internal routing state.
- Slack entity identity is workspace/team/channel/root-thread timestamp.
- GitHub entity identity is installation/repository/object type/object ID.
- Store occurrence and receipt timestamps separately.
- Only the current entity head contributes active derived knowledge.
- Explicit retention and deletion may delete data; normal ingestion never
  updates raw content.

### Knowledge

- Types: fact, decision, constraint, requirement, attempt, discovery,
  open_question, outcome, evidence.
- Trust states: observed, inferred, verified, proposed, conflicting, stale.
- Gemma-created items always begin as inferred.
- Every item cites one or more exact Source Event versions.
- Passing test, merged commit, or human confirmation may verify an item.
- Extraction failure creates no derived item.
- Raw excerpts may be searched and returned as observed evidence.

### Internal Work Threads

- Automatically group Source Entities, sessions, receipts, knowledge, changes,
  and outcomes.
- Correlate by explicit source references first, then repository relationships,
  existing session binding, and high-confidence lexical evidence.
- Low-confidence correlation stays internal and inactive.
- No public response, route name, dashboard label, or user action exposes the
  internal object.

## Work plan

### 1. Lock protocol v3

**Files:** `vendor/termyte-contract/`, `scripts/check-contract.mjs`,
`package.json`, server route schemas, contract tests.

- Replace the vendored v2 contract with the package session's first protocol
  commit.
- Copy the v3 fixtures and manifest byte-for-byte.
- Make `check:contract` validate protocol version and all hashes.
- Update server imports and error mapping.
- Keep old Work Thread routes temporarily only as private compatibility code;
  remove them from UI and public docs.

**Done when:** cloud parses every shared fixture and rejects deliberate drift.

### 2. Add launch schema migration

**Files:** new migration after `012_context_gateway_runtime.sql`,
`test/database.test.ts`.

Add only missing columns/tables:

- workspace access-policy confirmation timestamp and confirming admin;
- agent-session repository, branch, instruction snapshot, status, and outcome;
- Context Item trust status, confidence, freshness, extraction model/version,
  and normalized search vector;
- receipt abstention code/message, final packet, final packet hash, local item
  count, frozen cloud item IDs, acknowledged timestamp, and delivery state;
- intent-resolution evidence JSON containing query terms, hard filters, task
  scores, company scores, exclusions, and thresholds;
- connector sync/error metadata required by the dashboard.

Reuse existing tables where they already hold equivalent data. Do not create a
second session, receipt, source, queue, or knowledge table.

Add constraints:

- final packet and hash required only for delivered receipts;
- failed receipts require a failure code;
- acknowledged receipts cannot be changed;
- confidence is between 0 and 1;
- task/company scores are integers from 0 to 100;
- tenant-scoped foreign keys and indexes for every new relation.

**Done when:** clean migration and upgrade from migration 012 both pass.

### 3. Enforce workspace-wide source policy

**Files:** `src/admin.ts`, `src/server.ts`, `web/app.js`, migration, tests.

- Add an admin-only confirmation endpoint and audit event.
- Block connector scope selection until the policy is confirmed.
- Show plain disclosure: selected sources must be accessible to every workspace
  member; Termyte does not mirror live provider permissions.
- Re-confirm after the policy text version changes.
- Continue enforcing workspace isolation and connector mappings on every read.
- Never describe this as per-user permission-aware retrieval.

**Done when:** an unconfirmed workspace cannot index sources and cross-workspace
tests prove no source, knowledge, receipt, or activity leakage.

### 4. Complete GitHub ingestion first

**Files:** `src/connectors.ts`, `src/server.ts`, `src/worker.ts`, migration if
needed, `test/connectors.test.ts`, `test/database.test.ts`.

- Keep OAuth/webhook credentials encrypted with existing helpers.
- Verify GitHub webhook signatures before durable enqueue.
- Ingest repositories, issues, pull requests, reviews, commits, and changed-file
  metadata for selected repositories only.
- Implement incremental backfill with persisted cursors and bounded retry.
- Normalize canonical URLs, authors, repository keys, provider update times,
  stable entity keys, and provider delivery IDs.
- Store edits as immutable Source Event versions and advance only the current
  Source Entity head.
- Build explicit links from issue/PR/commit references and repository identity.
- Revoke stops sync. Delete removes selected indexed source data and dependent
  active knowledge through audited deletion.

**Done when:** webhook retry, edit, delayed delivery, pagination, rate limit,
revoke, and deletion tests pass.

### 5. Complete Slack full-thread ingestion

**Files:** existing Slack paths in `src/connectors.ts`, `src/server.ts`,
`src/worker.ts`, tests.

- Treat message webhooks only as verified sync triggers.
- Fetch every `conversations.replies` page using the encrypted OAuth credential.
- Store one ordered full-thread snapshot with root, replies, authors, original
  timestamps, and edit timestamps.
- Coalesce unchanged snapshots by current content hash without treating a hash
  as permanent identity.
- Store changed/reverted/delayed snapshots as immutable versions; delayed older
  versions never replace the current head.
- Preserve Slack source links for the thread and referenced messages.
- Apply selected-channel mappings before enqueue and retrieval.
- Revoke and deletion follow the same audited rules as GitHub.

**Done when:** root, reply, edit, pagination, unchanged sync, API failure,
recovery, revoke, and deletion tests pass.

### 6. Replace fallback synthesis with Gemma extraction

**Files:** replace/generalize `src/synthesis.ts`, `src/config.ts`,
`src/worker.ts`, `test/worker.test.ts`, new focused synthesis tests if useful.

- Configure Cloudflare Workers AI account URL, API token, model ID for Gemma 4
  27B, timeout, and extractor version.
- Keep the provider behind the existing small runtime function; do not add a
  framework or speculative multi-provider abstraction.
- Send bounded untrusted source content, allowed item types, existing active
  items, and stable source references.
- Require strict JSON output and validate with Zod.
- Reject unknown source references, invalid types, missing provenance, and
  out-of-range confidence.
- Retry one invalid/transient response, then mark the projection job failed.
- Remove `fallbackSlackSynthesis` and `projectSlackIntent` from production
  projection. Keyword rules must never create derived knowledge.
- Store model, extractor version, confidence, inferred status, timestamps, and
  exact provenance.
- Keep raw current source searchable after any extraction failure.
- Supersede derived items only after a complete new projection succeeds.

**Done when:** valid, invalid JSON, invented reference, timeout, 429, 5xx, empty
candidate, and retry-exhaustion tests prove no ungrounded item is stored.

### 7. Automate internal correlation

**Files:** `src/worker.ts`, `src/work.ts`, connector linking code, tests.

- Reuse existing Work Thread storage and session binding.
- Remove dependence on user-created work for launch sessions.
- Resolve or create internal grouping from explicit GitHub/Slack IDs, repository
  mappings, source links, existing session binding, then lexical evidence.
- Automatically create an internal thread for a clear new agent session when no
  eligible group exists.
- Never ask a user to choose, rename, merge, split, or update it.
- Store correlation evidence and confidence for diagnostics.
- Abstain from cloud delivery when correlation or item confidence is too low;
  raw ingestion continues.

**Done when:** a fresh session and connected sources correlate automatically,
while ambiguous sources never leak candidate group details.

### 8. Implement intent understanding and explainable retrieval

**Files:** refactor focused parts of `src/work.ts`; add one small retrieval module
only if needed; PostgreSQL indexes; `test/work.test.ts`, `test/briefing.test.ts`,
database tests.

- Build query terms from instruction, explicit IDs/URLs, repository, branch,
  changed files, recent files, and task-mode hint.
- Hard-filter by workspace, source grants, repository relationships, active
  state, freshness, and retained provenance.
- Use PostgreSQL full-text search plus explicit relationship signals.
- Calculate task relevance separately from company relevance.
- Task relevance gates delivery. Company relevance prioritizes task-relevant
  decisions, requirements, constraints, customer needs, risks, and verified
  outcomes.
- Centralize launch thresholds in one configuration object, not environment
  flags per weight.
- Return only items above task threshold and within `cloud_token_budget`.
- Omit stale/conflicting/inferred items based on explicit rules; conflicting
  evidence may be returned only when directly relevant and labeled.
- Record scores, query terms, reasons, exclusions, and thresholds in resolution
  evidence JSON.
- Return abstention for low confidence, no match, no allowed sources, or no
  indexed sources. Never return clarification.
- Do not call Gemma during retrieval and do not add embeddings.

**Done when:** tests prove repository boundaries, explicit-link priority,
company-intent priority within task-relevant results, deterministic top-k,
status filtering, and each abstention code.

### 9. Store exact merged Context Receipts

**Files:** `src/work.ts`, `src/admin.ts`, `src/server.ts`, migration,
`test/work.test.ts`, `test/database.test.ts`.

- Resolve creates a pending receipt for both context and abstention responses.
- Snapshot cloud item IDs, source versions, scores, reasons, exclusions, task
  mode, and expiry before returning.
- Acknowledge validates that all submitted cloud item IDs belong to the pending
  receipt.
- Recompute lowercase SHA-256 from `final_packet`; reject mismatches.
- Freeze final packet, hash, local count, delivery time, and delivery status in
  one transaction.
- Identical replay succeeds; different replay returns conflict.
- Failed acknowledgement records failure without a final packet.
- Receipt reads show the exact packet, local/cloud counts, source links,
  inclusion reasons, trust labels, and abstention diagnostics.
- Never expose the internal Work Thread ID in public receipt JSON.

**Done when:** the shared acknowledgement fixture freezes an immutable receipt
whose bytes and hash match the package injection.

### 10. Correlate activity and outcomes internally

**Files:** `src/work.ts`, event/outcome routes in `src/server.ts`, worker,
`test/work.test.ts`, database tests.

- Accept v3 events without Work Thread IDs.
- Resolve internal correlation from authenticated identity, session, repository,
  receipt, and existing session binding.
- Store occurrence and receipt times and observable/inferred boundaries.
- Project files, commands, tests, diffs, errors, and outcomes with exact event
  provenance.
- A passing test or merged commit may create verified evidence; an agent final
  response alone remains inferred or proposed.
- Keep batch and outcome idempotency.
- Make later retrieval eligible for relevant prior session outcomes.

### 11. Replace the dashboard information architecture

**Files:** `web/index.html`, `web/app.js`, `web/styles.css`, `src/admin.ts`,
`src/server.ts`, `test/web.test.ts`.

Expose six views:

1. Sessions
2. Sources
3. Knowledge
4. Receipts
5. Activity
6. Settings

Add list/detail admin endpoints shaped around those user objects. Reuse current
queries where possible but remove Work Thread names, IDs, filters, creation,
preview, grants, merge, split, and resolution-attention actions from the UI.

- Sessions show agent, instruction, repository, branch, status, timing, receipt,
  and outcome.
- Sources show connector, selected scopes, sync state, current raw record,
  immutable history, occurrence/receipt timestamps, and canonical links.
- Knowledge shows type, text, trust status, confidence, freshness, provenance,
  and incorrect/stale controls.
- Receipts show exact merged packet, sources, reasons, labels, omissions, and
  abstention.
- Activity shows files, commands, tests, diffs, errors, and outcomes.
- Settings shows members, agents, access confirmation, retention, export, and
  deletion.

Keep UI changes direct in the existing plain application. Do not introduce a
frontend framework.

**Done when:** `Work Thread` text and user actions are absent from rendered
launch routes and browser tests cover desktop and mobile navigation.

### 12. Operations and security

**Files:** `src/config.ts`, operations docs, metrics, health checks, tests.

- Validate Cloudflare AI credentials and connector secrets at startup only when
  the relevant feature is enabled.
- Never log tokens, raw secrets, unredacted prompts, or source payloads.
- Add metrics for connector lag, projection failures, extraction latency,
  retrieval latency, abstention code, delivered/failed receipts, outbox lag,
  and top-k evaluation runs.
- Health distinguishes API/database health from degraded connector or extraction
  workers.
- Keep bounded retries, graceful shutdown, retention, export, deletion, audit,
  backup, and restore checks.

### 13. Cloud verification

Run:

1. `npm run check:contract`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`
5. `npm run test:db` with clean PostgreSQL
6. Upgrade migrations from the migration-012 schema snapshot
7. Browser flow checks for setup and all six dashboard views

Use fixture provider servers for GitHub, Slack, and Cloudflare AI. Do not depend
on live external services in automated tests.

## Parallel coordination rules

- Start from the protocol appendix and current package fixtures if the package
  commit is not ready.
- Replace the vendored copy with the exact package commit as soon as it lands.
- Never change schemas only in cloud.
- Connector, extraction, dashboard, and migration work can proceed against
  fixture requests while package work continues.
- Report the contract hash, latest migration, and required environment variables
  to the package session.
- Keep current uncommitted work; inspect `git status` before every commit and do
  not overwrite unrelated changes.

## Final cross-repo gate

Against packed npm clients and a clean PostgreSQL database:

1. Create a workspace and confirm the shared source policy.
2. Connect fixture GitHub and Slack sources.
3. Ingest issue/PR/commit data and a complete Slack thread.
4. Extract inferred source-backed knowledge with Gemma fixture output.
5. Start Codex and retrieve task-relevant company intent.
6. Store the exact merged packet acknowledged by the package.
7. Capture files, commands, a passing test, diff metadata, and outcome.
8. Start Claude Code and retrieve the relevant prior outcome.
9. Verify cross-workspace and ungranted sources are absent.
10. Force ambiguity and verify abstention without clarification.
11. Force extraction failure and verify raw search works with no derived item.
12. Stop cloud and verify the package continues with local context.

## Evaluation gate

Create a labeled task set with expected source and knowledge IDs. For each task,
record top-k recall, precision, abstention, latency, and inclusion reasons.
Compare no briefing, manual briefing, and Termyte briefing. Do not add embeddings
unless recall remains poor after indexing and query expansion fixes.

## Completion criteria

- GitHub and Slack are complete launch connectors.
- Gemma extraction is grounded, validated, and fail-safe.
- Work Threads are automatic and invisible.
- Retrieval is explainable, intent-aware, and embedding-free.
- Ambiguity abstains without user interaction.
- Receipts store exact merged packets.
- Sessions, Sources, Knowledge, Receipts, Activity, and Settings are usable.
- Workspace isolation and configured grants prevent unauthorized delivery.
- Protocol and fixture hashes match the package repo.
- Full PostgreSQL and cross-repo launch proof passes.
