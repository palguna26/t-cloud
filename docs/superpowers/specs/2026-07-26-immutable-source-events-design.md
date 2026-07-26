# Immutable Source Events Design

## Goal

Keep every accepted source version unchanged while making the newest version the
only one used for current context extraction. Treat one Slack thread as one
source entity rather than processing its messages as separate Source Events.

## Scope

This design covers connector events from Slack, GitHub, and Linear. Agent events
remain insert-only and use one Source Entity per event so later Work Thread
routing changes never mutate their Source Event rows.

## Data model

Add a `source_entities` table for mutable routing state:

- workspace and provider;
- stable provider entity key;
- current Source Event ID;
- current Work Thread association;
- creation and update timestamps.

The stable entity keys are:

- Slack: `team_id:channel_id:thread_ts`, using the root message timestamp when
  `thread_ts` is absent;
- GitHub: installation, repository, object type, and object ID;
- Linear: organization, object type, and object ID.

Extend `source_events` with:

- `source_entity_id`;
- `supersedes_source_event_id`;
- `provider_event_id` for delivery deduplication;
- the existing `occurred_at`, `received_at`, `content_hash`, and normalized
  payload fields.

Source Event rows are append-only. Normal ingestion and linking must never
update them. Mutable head and Work Thread routing state belongs to
`source_entities`, not `source_events`.

PostgreSQL will reject Source Event updates. Explicit audited retention and user
deletion may delete events because privacy and retention controls take priority
over historical storage. They must not rewrite an existing event into a newer
version.

## Timestamp semantics

`occurred_at` is when the provider says the change happened:

- Slack: the latest message or edit timestamp represented by the snapshot;
- GitHub: the object or review update timestamp;
- Linear: the webhook or object update timestamp;
- agent activity: the runtime event timestamp.

`received_at` is when Termyte stored the event. Both remain immutable.

Slack snapshots also retain each message's original and edited timestamps in
their normalized JSON. Extraction receives the ordered timestamped messages so
later statements can supersede earlier statements inside the same thread.

## Connector ingestion

Provider delivery IDs deduplicate webhook retries:

- Slack `event_id`;
- GitHub `x-github-delivery`;
- Linear webhook ID.

If a provider omits a delivery ID, Termyte uses a deterministic fallback based
on the entity key, provider timestamp, and payload hash. A content hash may
detect an unchanged current snapshot, but it is not permanent identity because
an entity may legitimately return to older content.

For each accepted version, Termyte:

1. resolves or creates the Source Entity;
2. rejects an exact delivery retry;
3. inserts a new immutable Source Event;
4. records the previous head in `supersedes_source_event_id`;
5. advances the entity head only when the provider occurrence timestamp is not
   older than the current head;
6. keeps delayed older versions for audit without making them current;
7. enqueues projection when the head changes.

## Slack thread batching

Slack root messages, replies, and edits are triggers, not individual Source
Events. After signature verification, the API enqueues a `sync_slack_thread`
job and returns immediately.

The worker uses the encrypted Slack OAuth credential to fetch the complete
thread with `conversations.replies`. It sorts root and replies by Slack
timestamp and creates one normalized snapshot containing:

- thread identity;
- ordered messages;
- author IDs;
- text;
- original timestamps;
- edit timestamps.

Each successful sync may create one new immutable Source Event version. Several
queued triggers that resolve to the same full snapshot are safely coalesced by
the unchanged content hash. Termyte never projects an individual Slack reply in
isolation.

Slack API failures use the existing bounded job retry behavior. The Source
Entity head changes only after a complete snapshot is stored.

## Context extraction

Projection always reads the current Source Event from `source_entities`.

When the head changes:

1. mark active Context Items derived from the previous head as `superseded`;
2. extract from the complete new snapshot;
3. attach every new Context Item to the new Source Event;
4. prefer later timestamped Slack statements when the thread contradicts
   itself;
5. increment the Work Thread version once.

Historical Source Events and their superseded Context Items remain available
for audit until retention or explicit deletion removes them. Context Receipts
keep their stored source snapshots and remain unchanged.

## Migration

Create one Source Entity for each existing connector source identity and each
existing agent Source Event. Agent entities contain one immutable version;
connector entities may contain many versions.

Remove connector code that updates Source Event payloads or Work Thread IDs.
Move connector routing reads and writes to Source Entities. Replace retention's
payload update with deletion through the existing audited retention path.

## Errors and concurrency

- Lock the Source Entity while comparing and advancing its head.
- A duplicate provider delivery returns the existing event result.
- An unchanged full snapshot does not project again.
- An older delayed version is stored but does not supersede the head.
- Projection retries remain idempotent by Source Event ID.
- A Slack fetch failure leaves the previous head and context active.

## Tests

Add focused database-backed checks for:

- PostgreSQL rejecting Source Event updates;
- two edits producing two immutable versions;
- exact delivery retry deduplication;
- content reverting to an older value as a valid new version;
- delayed versions not replacing a newer head;
- one Slack thread producing one Source Entity and one snapshot per changed
  full-thread state;
- replies and edits causing full-thread re-extraction;
- older derived Context Items becoming `superseded`;
- occurrence and receipt timestamps remaining distinct and unchanged;
- Context Items retaining provenance to the exact version used.

## Acceptance

- No normal code path updates a Source Event.
- Every accepted provider edit remains queryable as a separate version.
- Only the current entity head supplies active extracted context.
- Slack is fetched, stored, and projected as a complete thread.
- Delayed delivery cannot make stale content current.
- Extraction and audit views can access provider and server timestamps.

## Non-goals

- semantic embeddings;
- a new queue system;
- storing each Slack reply as its own Source Event;
- changing Context Receipt immutability;
- preserving data beyond configured retention or explicit deletion.
