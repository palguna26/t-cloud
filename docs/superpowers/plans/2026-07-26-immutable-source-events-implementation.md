# Immutable Source Events Implementation Plan

Design: `docs/superpowers/specs/2026-07-26-immutable-source-events-design.md`

## 1. Add append-only source versioning

Files:

- `migrations/011_immutable_source_events.sql`
- `test/database.test.ts`

Changes:

- Create `source_entities` with provider, stable entity key, current Source Event,
  and current Work Thread routing.
- Add `source_entity_id`, `supersedes_source_event_id`, and
  `provider_event_id` to `source_events`.
- Backfill one entity and head for each existing connector Source Event.
- Replace the broad `(workspace_id, source, external_id)` unique constraint with:
  - the same partial uniqueness for agent events;
  - provider-delivery uniqueness for connector events.
- Add indexes for entity history ordered by `occurred_at` and `received_at`.
- Reject `UPDATE` on `source_events`; keep explicit `DELETE` for retention and
  user deletion.
- Add a database test proving an inserted event cannot be updated.

## 2. Normalize entity and delivery identity

Files:

- `src/connectors.ts`
- `test/connectors.test.ts`

Changes:

- Extend normalized connector input with `entityKey` and `providerEventId`.
- Read delivery IDs from Slack `event_id`, GitHub `x-github-delivery`, and the
  Linear webhook body.
- Use the provider change time for `occurredAt`.
- For Slack, normalize only enough webhook data to identify the complete thread:
  team, channel, and root thread timestamp.
- Add unit checks for stable entity keys, delivery IDs, edit timestamps, and
  reply-to-root grouping.

## 3. Store immutable connector snapshots

Files:

- `src/connectors.ts`
- `test/database.test.ts`

Changes:

- Replace connector `ON CONFLICT ... DO UPDATE` with an insert-only transaction.
- Lock or create the Source Entity before comparing its head.
- Return the existing result for an exact delivery retry.
- Insert changed content as a new Source Event, including its previous head.
- Store delayed older versions without advancing the head.
- Advance the entity head and enqueue projection only for a new current version.
- Move Work Thread routing from Source Event updates to `source_entities` and
  make accepted source-link decisions update the entity.
- Test edits, retries, reverted content, delayed delivery, head selection, and
  immutable provenance.

## 4. Sync Slack as complete threads

Files:

- `src/server.ts`
- `src/connectors.ts`
- `src/worker.ts`
- `test/connectors.test.ts`
- `test/database.test.ts`

Changes:

- After signature verification, enqueue `sync_slack_thread` instead of ingesting
  an individual Slack message.
- Reuse the encrypted connector credential and existing job queue.
- Fetch all `conversations.replies` pages with the Slack OAuth token.
- Sort root and replies by Slack timestamp and produce one normalized snapshot
  with per-message original and edit timestamps.
- Coalesce repeated triggers when the complete snapshot hash is unchanged.
- Retry Slack API failures without advancing the entity head.
- Test one thread, replies, edits, pagination, unchanged snapshots, and failure
  retry behavior with a mocked Slack API.

## 5. Supersede old extracted context

Files:

- `src/worker.ts`
- `src/work.ts`
- `test/worker.test.ts`
- `test/database.test.ts`

Changes:

- Project connector content only when its Source Event is the entity head.
- Mark active Context Items from the previous head as `superseded`.
- Extract the full Slack thread in timestamp order.
- Link new Context Items only to the exact current Source Event.
- Increment the Work Thread version once per accepted head projection.
- Remove the old delete-and-recreate projection path.
- Test full re-extraction, timestamp order, superseded items, exact provenance,
  idempotent retries, and one version increment.

## 6. Keep reads and retention correct

Files:

- `src/admin.ts`
- `src/worker.ts`
- `web/app.js`
- `test/database.test.ts`

Changes:

- Read current source state through `source_entities` while retaining version
  history for audit views.
- Show whether a displayed Source Event is current or superseded and show both
  occurrence and receipt timestamps.
- Replace retention payload mutation with the existing audited deletion path.
- Ensure explicit source deletion moves the entity head to the newest remaining
  version or clears it, then removes active derived context when required.
- Test current/history reads, retention, deletion, and receipt snapshots.

## 7. Verify the complete flow

Files:

- `IMPLEMENTATION.md`
- `OPERATIONS.md`

Checks:

1. Run `npm run verify`.
2. Run PostgreSQL integration tests with `TEST_DATABASE_URL`.
3. Run migrations against an empty database and an existing schema snapshot.
4. Replay a Slack delivery and confirm no duplicate version.
5. Add a reply and an edit, confirming one entity, immutable history, a new
   current head, superseded old context, and one Work Thread version increase.
6. Update documentation to describe Source Entities, immutable Source Event
   versions, timestamps, and Slack thread batching.

## Done when

- Normal application code contains no `UPDATE source_events` statement.
- PostgreSQL rejects Source Event updates.
- Every accepted edit is an immutable version.
- Delayed versions cannot replace newer context.
- Slack is stored and projected only as a complete thread snapshot.
- Only the current version contributes active Context Items.
- The full non-database and PostgreSQL-backed verification passes.
