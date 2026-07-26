# Termyte Cloud Context Control Plane Implementation Plan

**Repository:** `C:\Users\Palguna\Desktop\termyte-cloud`  
**Session owner:** PostgreSQL state, synthesis, selection, refresh API, receipts  
**Date:** July 26, 2026

## Start here

Implement this plan in order. Do not restore or edit the user-deleted `IMPLEMENTATION.md`. Preserve unrelated worktree changes.

Before editing:

```powershell
Set-Location C:\Users\Palguna\Desktop\termyte-cloud
git -c safe.directory='C:/Users/Palguna/Desktop/termyte-cloud' status --short
C:\nvm4w\nodejs\npm.cmd run verify
```

Current verified baseline:

- Commit: `be5d405`
- Only known worktree change: deleted `IMPLEMENTATION.md`
- `npm run verify`: passed 22 tests; all 14 PostgreSQL tests were skipped because `TEST_DATABASE_URL` was absent
- Immutable Source Event versioning and full Slack-thread snapshots already exist
- Context resolution, Context Items, receipts, grants, outcomes, durable jobs, and abstention already exist

## Goal

Turn the existing cloud workflow into the evidence-first Context Gateway:

```text
immutable evidence
-> hybrid projection
-> current Work Thread
-> deterministic task and item selection
-> initial or checkpoint briefing
-> immutable receipt
-> agent execution becomes new evidence
```

Do not add a dedicated vector database, WebSockets, another queue, or a model proxy.

## Parallel-session contract handoff

The runtime session owns protocol v2. Begin Tasks 1-3 while it updates and packs the contract.

Before Task 4, obtain the runtime tarball created under `C:\tmp`, replace the vendored contract using the same file layout already under `vendor/termyte-contract`, update its version check, and run:

```powershell
C:\nvm4w\nodejs\npm.cmd run check:contract
```

Do not hand-edit a second independent protocol definition.

Expected v2 additions:

- task modes
- opaque clarification selection tokens
- delivered/failed receipt acknowledgement
- context refresh request and response schemas
- initial/delta/full-refresh receipt types

If the tarball is not ready, continue through Task 3 and the worker portions of Tasks 5-6. Do not guess the final wire schema.

## Task 1: Add migration 012 for bindings and receipt lifecycle

Files:

- `migrations/012_context_gateway_runtime.sql`
- `test/database.test.ts`

Add to `agent_sessions`:

```text
bound_work_thread_id uuid nullable
binding_receipt_id uuid nullable
binding_source text nullable: explicit | resolved | clarified | handoff
bound_at timestamptz nullable
```

Add to `context_receipts`:

```text
previous_receipt_id uuid nullable
receipt_type text: initial | delta | full_refresh | cached_fallback
task_mode text: implement | investigate | review | verify | continue | general
delivery_status text: pending | delivered | failed | expired
failure_code text nullable
expires_at timestamptz
```

Backfill:

- existing acknowledged receipts -> `delivered`
- other existing receipts -> `expired`
- existing receipts -> `initial`, `general`
- expiry from existing creation time plus five minutes

Add to `context_receipt_items`:

```text
section text
item_text_snapshot text
authority_snapshot smallint
confidence_snapshot real
```

Backfill snapshots from existing `source_snapshot_json`. Keep that JSON for source references.

Add to `context_items`:

```text
supersedes_context_item_id uuid nullable
normalized_hash text nullable
projector_version integer default 1
```

Constraints:

- one session can bind to at most one current Work Thread
- a delivered acknowledgement requires `delivered_at`
- a failed acknowledgement requires `failure_code`
- receipt snapshot rows remain after the source Context Item changes

Indexes:

```text
agent_sessions(workspace_id, agent_identity_id, source_session_id)
agent_sessions(workspace_id, bound_work_thread_id)
context_receipts(agent_session_id, created_at desc)
context_receipts(work_thread_id, work_thread_version)
context_items(work_thread_id, state, type, updated_at desc)
```

Acceptance:

- Empty and existing database migrations pass.
- Existing receipts remain readable.
- Source Event immutability remains enforced.

## Task 2: Make agent projection evidence-aware

Files:

- `src/worker.ts`
- `test/worker.test.ts`
- `test/database.test.ts`

Current worker behavior maps events with fixed text and supersedes broad item types. Replace only the weak parts.

Rules:

| Agent event | Context Item | Authority |
|---|---|---:|
| user prompt | objective or next_action | declared |
| file/tool action | observation | observed |
| failed command/test | failure | observed |
| passing recognized test | evidence | verified |
| final response | outcome | claimed |
| explicit human confirmation | outcome/evidence | verified |

Use the existing numeric authority scale; document its mapping in code and tests rather than adding another table.

Changes:

1. Keep each accepted Context Item source-backed.
2. Do not treat an agent final response as verification.
3. A passing test supersedes current failure state only when it addresses the same normalized subject; the old failure stays historical.
4. Add or confirm identical claims by `normalized_hash`; attach new sources rather than inserting duplicate briefing lines.
5. Increment the Work Thread version once per material projection transaction.
6. Keep projection idempotent by Source Event and projector version.

Use PostgreSQL row locks for concurrent updates. Do not add distributed locking.

## Task 3: Add hybrid organizational synthesis with deterministic fallback

Files:

- `src/synthesis.ts` (one focused module)
- `src/config.ts`
- `src/worker.ts`
- `test/synthesis.test.ts`
- `test/worker.test.ts`
- `test/database.test.ts`

Use an LLM only for organizational Source Events such as Slack threads. Keep coding-agent event mapping deterministic so Cloud does not violate source-agent synthesis affinity.

Configuration:

```text
CONTEXT_SYNTHESIS_BASE_URL?
CONTEXT_SYNTHESIS_API_KEY?
CONTEXT_SYNTHESIS_MODEL?
CONTEXT_SYNTHESIS_TIMEOUT_MS default 5000
```

Use native `fetch` and existing Zod. Add no SDK dependency.

Input:

- current Work Thread goal/status
- current active Context Items
- one bounded complete Slack-thread snapshot
- allowed item types
- stable Source Event references
- untrusted-data delimiters

Structured output:

```text
candidates[]:
  type
  text
  confidence
  source references
suggested_summary
possible_contradictions[]
```

Validation:

1. Strict schema.
2. Every source reference must exist in the input window.
3. Same workspace and repository.
4. Redact again before persistence.
5. One structured-output retry.
6. On absent config, timeout, invalid output, or retry failure, use the existing deterministic `projectSlackIntent()` result and record the fallback reason on the job/audit metadata.

Do not call the LLM during context resolution.

Acceptance:

- A full Slack thread extracts problem, constraint, failed attempt, expected result, and correction.
- Prompt injection inside Slack remains quoted data.
- LLM failure still produces deterministic useful context.

## Task 4: Consume protocol v2

Files:

- `vendor/termyte-contract/**`
- `scripts/check-contract.mjs`
- `package.json` / lockfile only if the local file dependency requires refresh
- contract-facing tests

Changes:

1. Import the runtime session's packed v2 artifact.
2. Update the exact vendored version check.
3. Verify all exported subpaths.
4. Do not copy protocol schemas into `src/`.

Acceptance:

- `npm run check:contract` proves Cloud loads the same v2 schemas used by the runtime.

## Task 5: Make session binding canonical

Files:

- `src/work.ts`
- `test/database.test.ts`

Resolution order:

1. Authorized explicit Work Thread ID
2. Valid opaque clarification selection token
3. Authorized existing session binding
4. Handoff
5. Repository-filtered matching

Rules:

- Reauthorize every binding read.
- Repository mismatch invalidates the binding.
- A vague prompt never switches a bound session.
- Explicit selection may replace the binding only after successful receipt delivery.
- Do not bind while creating a pending receipt.
- Bind inside the delivered-acknowledgement transaction.

Opaque clarification tokens:

- Store the authorized candidate set in `context_resolution_attempts`.
- Sign or randomly generate short-lived opaque tokens tied to workspace, identity, session, attempt, and candidate.
- Resolve a token only for the same principal and unexpired attempt.
- Never return raw Work Thread IDs in clarification candidates.

Acceptance:

- Another identity cannot redeem a token.
- An expired token fails as not found.
- Successful delivery binds once.
- Failed delivery does not bind.

## Task 6: Refactor deterministic task resolution and record evidence

Files:

- `src/work.ts`
- `test/work.test.ts`
- `test/database.test.ts`
- one small labelled fixture under `test/fixtures/`

Keep PostgreSQL FTS and trigram search. Do not add embeddings yet.

Hard filters:

- workspace
- active agent grant
- exact repository when provided
- context-delivery flags
- active Work Thread status

Scoring inputs:

```text
explicit identifier: 0 or 40
lexical match:        0-20
status relevance:     0-10
recency:              0-5
task-mode fit:        0-5
recent participation: 0-10
handoff:              0-10
```

Use one constants object. Keep the initial select threshold and ambiguity margin visible and testable.

Store in receipt or resolution-attempt evidence:

- candidate IDs internally
- every component score
- threshold
- margin
- selected rule
- omissions

Add a labelled evaluation fixture containing at least:

- `Fix that auth bug` -> auth Work Thread
- `Review that auth fix` -> same Work Thread after implementation
- unrelated landing-page prompt -> not found
- two recent auth bugs -> clarification
- explicit ID -> exact selection
- bound session plus vague follow-up -> existing binding

Report wrong-thread, abstention, and clarification counts in the test output or assertions. Add semantic retrieval only after this fixture proves lexical selection is insufficient.

## Task 7: Add task-mode Context Item selection

Files:

- `src/work.ts`
- `test/briefing.test.ts`
- `test/database.test.ts`

Determine final task mode from the runtime hint plus request words. Use `general` when uncertain; no LLM call.

Required briefing core:

```text
Work
Goal
Current state
Constraints
Expected result
Next action
```

Mode priority:

| Mode | Priority |
|---|---|
| implement | problem, constraints, failures, files, verification |
| investigate | symptoms, reproduction, failed investigations, open questions |
| review | original goal, changed files, verification, claims, risks |
| verify | expected result, claimed outcome, required checks, prior failures |
| continue | objective, latest state, completed work, blocker, next action |
| general | core plus recent high-authority items |

Selection order:

1. Required core
2. Mode relevance
3. Current over superseded
4. Higher authority
5. Prompt relevance
6. Recency
7. Shorter equivalent representation

Target 2,000 tokens. Remove duplicates and low-priority history first. Never remove goal, critical constraint, expected result, relevant failed attempt, current blocker, or sources.

Receipt rows must snapshot section, text, authority, confidence, source IDs, position, and inclusion reason.

## Task 8: Correct receipt lifecycle

Files:

- `src/work.ts`
- `src/server.ts`
- `test/database.test.ts`

Changes:

1. Resolve creates `pending` receipt with expiry.
2. Acknowledge accepts `delivered` or `failed` idempotently.
3. `delivered` atomically:
   - marks delivery time/status;
   - binds the session to the selected Work Thread;
   - records binding receipt and source;
   - writes audit event.
4. `failed` stores failure code and leaves the session unbound.
5. Repeated identical acknowledgement returns success; conflicting terminal acknowledgement returns conflict.
6. Expire old pending receipts through the existing worker/retention mechanism.

Acceptance:

- A gateway response alone is not counted as delivered.
- Historical receipt text and items never change after later projection.

## Task 9: Add checkpoint refresh API

Files:

- `src/work.ts`
- `src/server.ts`
- `src/worker.ts` only if projection-through-event visibility is needed
- `test/database.test.ts`

Add `POST /v1/context/refresh` using protocol v2.

Flow:

1. Authenticate `context:read`.
2. Load and reauthorize the session binding.
3. Verify prior receipt belongs to the same principal, session, and Work Thread.
4. If binding is absent or invalid, return `binding_lost`.
5. If the checkpoint Source Event is accepted but not projected, return `pending` with a short retry hint.
6. If Work Thread version did not change, return `unchanged`.
7. Re-run current task-mode item selection.
8. Compare selected item snapshots with the previous receipt.
9. Ignore non-material wording-only changes.
10. Build `delta` when fewer than half of prior selected items are stale; otherwise build `full_refresh`.
11. Create a pending refresh receipt. Delivery acknowledgement uses Task 8.

Material changes:

- constraint
- contradiction
- blocker
- verification
- expected result
- higher-authority replacement
- relevant change from another agent
- next action

No polling and no push channel.

## Task 10: Make projection visibility explicit

Files:

- `src/server.ts`
- `src/worker.ts`
- `test/database.test.ts`

The runtime needs to know whether its checkpoint event has been projected.

Use existing records:

- accepted Source Event
- `project_event` job state
- Work Thread version

Do not add a second projection-status table unless existing job history is deleted too early to answer reliably. If needed, add one `projected_at` timestamp or projector-version field to the Source Event's associated job metadata, not a new service.

Acceptance:

- Refresh returns pending while the causative event is queued.
- After one worker run, the same refresh idempotency key returns the stable updated result or use a new retry key explicitly defined by the protocol tests.

## Task 11: End-to-end database proof

Add one PostgreSQL integration test covering:

```text
Slack full thread
-> immutable Source Event head
-> hybrid or deterministic fallback projection
-> Codex initial resolution
-> pending receipt
-> delivered acknowledgement and binding
-> failed test event
-> refresh pending
-> worker projection
-> delta refresh
-> delivered delta receipt
-> edit + passing test + claimed outcome
-> Claude review resolution
-> review-specific briefing with original source and Codex evidence
```

Also prove:

- duplicate event and resolve requests are idempotent
- unrelated repository is excluded
- ambiguous request returns opaque choices
- final agent claim is not verified evidence
- previous failure remains historically visible
- receipt snapshots remain unchanged
- workspace and grant isolation hold at every step

## Task 12: Operational proof

Required commands:

```powershell
C:\nvm4w\nodejs\npm.cmd run verify
$env:TEST_DATABASE_URL = '<clean PostgreSQL database>'
C:\nvm4w\nodejs\npm.cmd run test:db
C:\nvm4w\nodejs\npm.cmd run build
git -c safe.directory='C:/Users/Palguna/Desktop/termyte-cloud' status --short
```

Do not report success if PostgreSQL tests skip.

Then integrate the packed runtime from the other session and run the real two-agent flow three times.

Measure:

- resolution latency
- wrong-thread selections
- clarification and abstention
- projection delay
- receipt acknowledgement delay
- missing or noisy Context Items
- manual intervention

## Done when

- Cloud and runtime use the same v2 protocol artifact.
- Source Events remain immutable.
- Slack synthesis is LLM-assisted with deterministic failure fallback.
- Task and item selection are deterministic and inspectable.
- Delivery, not response creation, binds the session.
- Material checkpoint refresh produces immutable delta/full receipts.
- A second agent receives the first agent's evidence.
- All PostgreSQL integration tests run and pass.

## Research references

- [OpenAI Codex hooks documentation](https://learn.chatgpt.com/docs/hooks.md)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)

