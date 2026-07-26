import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { TERMYTE_PROTOCOL_VERSION } from "termyte/protocol";
import { TermyteAgentClient } from "termyte/agent-sdk";
import { issueAgentCredential } from "../src/agent-auth.js";
import { createDatabase, type Database } from "../src/db.js";
import { createApp } from "../src/server.js";
import { runOneJob } from "../src/worker.js";
import { encryptCredentials } from "../src/connectors.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const pepper = "integration-test-pepper-value-32-bytes";
let db: Database;
let workspaceId: string;
let allowedToken: string;
let deniedToken: string;
let workThreadId: string;
let allowedAgentId: string;
let deniedAgentId: string;
let claudeAgentId: string;
let claudeToken: string;
let reviewAgentId: string;
let reviewToken: string;
let ownerUserId: string;

suite("PostgreSQL tenant and Agent Identity boundaries", () => {
  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await db.query(`DELETE FROM rate_limit_buckets`);
    await db.query(`DELETE FROM jobs WHERE kind = 'stripe_event'`);
    workspaceId = randomUUID();
    const owner = randomUUID();
    ownerUserId = owner;
    allowedAgentId = randomUUID();
    deniedAgentId = randomUUID();
    claudeAgentId = randomUUID();
    reviewAgentId = randomUUID();
    workThreadId = randomUUID();
    const allowed = issueAgentCredential(pepper);
    const denied = issueAgentCredential(pepper);
    const claude = issueAgentCredential(pepper);
    const review = issueAgentCredential(pepper);
    allowedToken = allowed.token;
    deniedToken = denied.token;
    claudeToken = claude.token;
    reviewToken = review.token;

    await db.query(`
      INSERT INTO workspaces (id, name, slug, owner_user_id)
      VALUES ($1, 'Test', $2, $3)
    `, [workspaceId, `test-${workspaceId}`, owner]);
    await db.query(`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES ($1, $2, 'owner')
    `, [workspaceId, owner]);
    await db.query(`
      INSERT INTO agent_identities (id, workspace_id, name, kind, created_by_user_id)
      VALUES
        ($1, $5, 'Allowed', 'codex', $6),
        ($2, $5, 'Denied', 'codex', $6),
        ($3, $5, 'Claude receiver', 'claude-code', $6),
        ($4, $5, 'OpenCode reviewer', 'opencode', $6)
    `, [allowedAgentId, deniedAgentId, claudeAgentId, reviewAgentId, workspaceId, owner]);
    await db.query(`
      INSERT INTO agent_credentials (
        id, workspace_id, agent_identity_id, token_prefix, secret_hash, scopes, created_by_user_id
      ) VALUES
        ($1, $2, $3, $4, $5, ARRAY['events:write','context:read','outcomes:write','handoffs:create','handoffs:claim'], $6),
        ($7, $2, $8, $9, $10, ARRAY['events:write','context:read','outcomes:write','handoffs:create','handoffs:claim'], $6),
        ($11, $2, $12, $13, $14, ARRAY['events:write','context:read','outcomes:write','handoffs:create','handoffs:claim'], $6),
        ($15, $2, $16, $17, $18, ARRAY['events:write','context:read','outcomes:write','handoffs:create','handoffs:claim'], $6)
    `, [
      randomUUID(), workspaceId, allowedAgentId, allowed.prefix, allowed.secretHash, owner,
      randomUUID(), deniedAgentId, denied.prefix, denied.secretHash,
      randomUUID(), claudeAgentId, claude.prefix, claude.secretHash,
      randomUUID(), reviewAgentId, review.prefix, review.secretHash,
    ]);
    await db.query(`
      INSERT INTO work_threads (
        id, workspace_id, title, objective, status, idempotency_key, created_by_agent_identity_id
      ) VALUES ($1, $2, 'Auth bug', 'Fix refresh rotation', 'active', 'seed-auth', $3)
    `, [workThreadId, workspaceId, allowedAgentId]);
    await db.query(`
      INSERT INTO work_thread_agent_grants (
        id, workspace_id, work_thread_id, agent_identity_id, source
      ) VALUES ($1, $2, $3, $4, 'creator')
    `, [randomUUID(), workspaceId, workThreadId, allowedAgentId]);
  });

  afterAll(async () => {
    if (db) {
      await db.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
      await db.end();
    }
  });

  it("accepts permitted events idempotently and rejects an ungranted agent", async () => {
    const app = createApp(db, pepper);
    const body = {
      schema_version: TERMYTE_PROTOCOL_VERSION,
      events: [{
        event_id: "event:auth:1",
        event_type: "failure",
        agent_session_id: "fresh-session",
        work_thread_id: workThreadId,
        occurred_at: Date.now(),
        source: { platform: "codex" },
        content: "The first attempt failed.",
      }],
    };
    const request = (token: string) => app.request("/v1/events/batch", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const denied = await request(deniedToken);
    expect(denied.status).toBe(403);

    const accepted = await request(allowedToken);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      accepted_event_ids: ["event:auth:1"],
      existing_event_ids: [],
    });

    const replay = await request(allowedToken);
    expect(await replay.json()).toMatchObject({
      accepted_event_ids: [],
      existing_event_ids: ["event:auth:1"],
    });
  });

  it("redacts coding-agent secrets again before hosted persistence", async () => {
    const app = createApp(db, pepper, {
      authenticateHuman: async (token) =>
        token === "human-session" ? { userId: ownerUserId } : null,
    });
    const response = await app.request("/v1/events/batch", {
      method: "POST",
      headers: {
        authorization: `Bearer ${allowedToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: TERMYTE_PROTOCOL_VERSION,
        events: [{
          event_id: "server-redaction-event",
          event_type: "observation",
          agent_session_id: "redaction-session",
          occurred_at: Date.now(),
          source: { platform: "codex" },
          content: "api_key=supersecretvalue",
          metadata: { password: "hunter2" },
        }],
      }),
    });
    expect(response.status).toBe(200);
    const stored = await db.query(`
      SELECT payload_json, payload_text, redaction_state
      FROM source_events
      WHERE workspace_id = $1 AND external_id = 'server-redaction-event'
    `, [workspaceId]);
    expect(JSON.stringify(stored.rows[0])).not.toContain("supersecretvalue");
    expect(JSON.stringify(stored.rows[0])).not.toContain("hunter2");
    expect(stored.rows[0].payload_text).toContain("[REDACTED:api_key]");
    expect(stored.rows[0].redaction_state).toBe("server");
  });

  it("turns verified organizational events into context for a fresh coding agent", async () => {
    const slackId = randomUUID();
    const linearId = randomUUID();
    const githubId = randomUUID();
    const teamId = `T-${randomUUID()}`;
    const organizationId = `ORG-${randomUUID()}`;
    const installationId = String(Date.now());
    const channelId = `C-${randomUUID()}`;
    const linearTeamId = `TEAM-${randomUUID()}`;
    const connectorEncryptionKey = randomBytes(32);
    await db.query(`
      INSERT INTO connector_connections (
        id, workspace_id, provider, name, external_account_id,
        credentials_ciphertext, created_by_user_id
      ) VALUES
        ($1, $4, 'slack', 'Customer Slack', $5, $9, $7),
        ($2, $4, 'linear', 'Product Linear', $6, NULL, $7),
        ($3, $4, 'github', 'Engineering GitHub', $8, NULL, $7)
    `, [
      slackId,
      linearId,
      githubId,
      workspaceId,
      teamId,
      organizationId,
      ownerUserId,
      installationId,
      encryptCredentials(connectorEncryptionKey, { access_token: "xoxb-test" }),
    ]);
    await db.query(`
      INSERT INTO connector_scope_mappings (
        id, workspace_id, connector_connection_id, external_scope_id,
        external_scope_name, repository_key, created_by_user_id
      ) VALUES
        (gen_random_uuid(), $1, $2, $3, '#customer-bugs', 'termyte/app', $6),
        (gen_random_uuid(), $1, $4, $5, 'Authentication', 'termyte/app', $6)
    `, [workspaceId, slackId, channelId, linearId, linearTeamId, ownerUserId]);

    const secrets = {
      github: "github-connector-test-secret",
      slack: "slack-connector-test-secret",
      linear: "linear-connector-test-secret",
    };
    const now = Date.now();
    let slackMessages: Array<Record<string, any>> = [{
      type: "message",
      channel: channelId,
      ts: String(now / 1_000),
      text: "Customer reports an authentication refresh bug. Keep existing sessions active.",
    }];
    const slackFetch = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      messages: slackMessages,
      response_metadata: { next_cursor: "" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = createApp(db, pepper, {
      connectorRuntime: {
        encryptionKey: connectorEncryptionKey,
        webhookSecrets: secrets,
        fetch: slackFetch as typeof fetch,
      },
    });
    const slackBody = JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      event: {
        type: "message",
        channel: channelId,
        ts: String(now / 1_000),
        text: "Customer reports an authentication refresh bug. Keep existing sessions active.",
      },
    });
    const slackTimestamp = String(Math.floor(now / 1_000));
    const slack = await app.request("/webhooks/connectors/slack", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": slackTimestamp,
        "x-slack-signature": `v0=${createHmac("sha256", secrets.slack)
          .update(`v0:${slackTimestamp}:${slackBody}`).digest("hex")}`,
      },
      body: slackBody,
    });
    expect(slack.status).toBe(200);
    expect(await slack.json()).toMatchObject({ received: true, accepted: true });
    const slackReplay = await app.request("/webhooks/connectors/slack", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": slackTimestamp,
        "x-slack-signature": `v0=${createHmac("sha256", secrets.slack)
          .update(`v0:${slackTimestamp}:${slackBody}`).digest("hex")}`,
      },
      body: slackBody,
    });
    expect(await slackReplay.json()).toMatchObject({ duplicate: true });
    expect((await db.query(`
      SELECT count(*)::integer AS count FROM jobs
      WHERE kind = 'sync_slack_thread' AND workspace_id = $1
    `, [workspaceId])).rows[0].count).toBe(1);

    const linearBody = JSON.stringify({
      organizationId,
      type: "Issue",
      action: "create",
      webhookTimestamp: now,
      data: {
        id: randomUUID(),
        teamId: linearTeamId,
        title: "Fix authentication refresh bug",
        description: "Do not change session expiry. Expected result: refresh returns a new cookie.",
        url: "https://linear.app/example/issue/AUTH-1",
        createdAt: new Date(now).toISOString(),
      },
    });
    const linear = await app.request("/webhooks/connectors/linear", {
      method: "POST",
      headers: {
        "webhook-timestamp": String(now),
        "linear-signature": createHmac("sha256", secrets.linear)
          .update(linearBody).digest("hex"),
      },
      body: linearBody,
    });
    expect(linear.status).toBe(200);

    const githubBody = JSON.stringify({
      action: "opened",
      installation: { id: installationId },
      repository: { id: 991, full_name: "termyte/app" },
      issue: {
        id: 992,
        title: "Authentication refresh bug",
        body: "A prior attempt failed in src/auth/refresh.ts.",
        html_url: "https://github.com/termyte/app/issues/992",
        created_at: new Date(now).toISOString(),
      },
    });
    const github = await app.request("/webhooks/connectors/github", {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secrets.github)
          .update(githubBody).digest("hex")}`,
      },
      body: githubBody,
    });
    expect(github.status).toBe(200);

    while (await runOneJob(db, "connector-test-worker", {
      encryptionKey: connectorEncryptionKey,
      fetch: slackFetch as typeof fetch,
    })) {
      const pending = Number((await db.query(`
        SELECT count(*)::integer AS n FROM jobs
        WHERE workspace_id = $1 AND state IN ('pending', 'failed', 'leased')
      `, [workspaceId])).rows[0].n);
      if (pending === 0) break;
    }
    const connectorWork = (await db.query<{ id: string }>(`
      SELECT id FROM work_threads
      WHERE workspace_id = $1 AND repository_key = 'termyte/app'
        AND idempotency_key LIKE 'connector:%'
      ORDER BY created_at DESC LIMIT 1
    `, [workspaceId])).rows[0];
    expect(connectorWork).toBeTruthy();
    const response = await app.request("/v1/context/resolve", {
      method: "POST",
      headers: {
        authorization: `Bearer ${allowedToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: TERMYTE_PROTOCOL_VERSION,
        request_text: "Fix authentication refresh bug",
        agent_session_id: "fresh-organizational-context-session",
        repository_key: "termyte/app",
        idempotency_key: `connector-context-${randomUUID()}`,
      }),
    });
    expect(response.status).toBe(200);
    const resolved = await response.json() as any;
    expect(resolved).toMatchObject({
      state: "resolved",
      work_thread_id: connectorWork.id,
    });
    expect(resolved.briefing).toContain("authentication");
    expect(resolved.sources.length).toBeGreaterThanOrEqual(1);

    slackMessages = [{
      ...slackMessages[0]!,
      text: "Customer reports an authentication refresh bug.\nReturn a rotated cookie without ending active sessions.",
      edited: { ts: String((now + 1_000) / 1_000) },
    }];
    const editBody = JSON.stringify({
      type: "event_callback",
      event_id: `Ev-${randomUUID()}`,
      team_id: teamId,
      event: {
        type: "message",
        subtype: "message_changed",
        channel: channelId,
        event_ts: String((now + 1_000) / 1_000),
        message: slackMessages[0],
      },
    });
    const editTimestamp = String(Math.floor(now / 1_000));
    expect((await app.request("/webhooks/connectors/slack", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": editTimestamp,
        "x-slack-signature": `v0=${createHmac("sha256", secrets.slack)
          .update(`v0:${editTimestamp}:${editBody}`).digest("hex")}`,
      },
      body: editBody,
    })).status).toBe(200);
    while (await runOneJob(db, "connector-edit-worker", {
      encryptionKey: connectorEncryptionKey,
      fetch: slackFetch as typeof fetch,
    })) {
      // Drain the thread sync and projection jobs.
    }
    const versions = await db.query(`
      SELECT event.id, entity.current_source_event_id,
        event.occurred_at, event.received_at
      FROM source_events event
      JOIN source_entities entity ON entity.id = event.source_entity_id
      WHERE event.workspace_id = $1 AND event.source = 'slack'
        AND entity.entity_key = $2
      ORDER BY event.occurred_at
    `, [workspaceId, `${teamId}:${channelId}:${now / 1_000}`]);
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[1].id).toBe(versions.rows[1].current_source_event_id);
    const projectedStates = await db.query(`
      SELECT item.state, count(*)::integer AS count
      FROM context_items item
      JOIN context_item_sources source ON source.context_item_id = item.id
      JOIN source_events event ON event.id = source.source_event_id
      WHERE event.source_entity_id = (
        SELECT source_entity_id FROM source_events WHERE id = $1
      )
      GROUP BY item.state
    `, [versions.rows[1].id]);
    expect(projectedStates.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "active" }),
      expect.objectContaining({ state: "superseded" }),
    ]));
    await expect(db.query(`
      UPDATE source_events SET payload_text = 'mutated' WHERE id = $1
    `, [versions.rows[0].id])).rejects.toThrow(/immutable/i);
  });

  it("rate limits repeated unauthenticated device starts", async () => {
    const app = createApp(db, pepper);
    const request = () => app.request("/v1/device/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.77",
      },
      body: JSON.stringify({
        schema_version: TERMYTE_PROTOCOL_VERSION,
        device_name: "Rate limit test",
        platform: "codex",
        requested_scopes: ["events:write"],
      }),
    });
    for (let index = 0; index < 20; index += 1) {
      expect((await request()).status).toBe(201);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    await db.query(`DELETE FROM device_flow_requests WHERE device_name = 'Rate limit test'`);
  });

  it("keeps Work Threads isolated between workspaces", async () => {
    const otherWorkspaceId = randomUUID();
    const otherOwner = randomUUID();
    const otherAgentId = randomUUID();
    const credential = issueAgentCredential(pepper);
    await db.query(`
      INSERT INTO workspaces (id, name, slug, owner_user_id)
      VALUES ($1, 'Other', $2, $3)
    `, [otherWorkspaceId, `other-${otherWorkspaceId}`, otherOwner]);
    await db.query(`
      INSERT INTO agent_identities (id, workspace_id, name, kind, created_by_user_id)
      VALUES ($1, $2, 'Other Codex', 'codex', $3)
    `, [otherAgentId, otherWorkspaceId, otherOwner]);
    await db.query(`
      INSERT INTO agent_credentials (
        id, workspace_id, agent_identity_id, token_prefix, secret_hash, scopes, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, ARRAY['events:write','context:read','handoffs:create'], $6)
    `, [
      randomUUID(),
      otherWorkspaceId,
      otherAgentId,
      credential.prefix,
      credential.secretHash,
      otherOwner,
    ]);
    const app = createApp(db, pepper);
    const call = (path: string, body: Record<string, unknown>) => app.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ schema_version: TERMYTE_PROTOCOL_VERSION, ...body }),
    });

    const event = await call("/v1/events/batch", {
      events: [{
        event_id: "cross-tenant-event",
        event_type: "observation",
        agent_session_id: "other-session",
        work_thread_id: workThreadId,
        occurred_at: Date.now(),
        source: { platform: "codex" },
        content: "Must not cross the workspace boundary",
      }],
    });
    expect(event.status).toBe(403);
    const context = await call("/v1/context/resolve", {
      request_text: "Show the auth bug",
      agent_session_id: "other-session",
      work_thread_id: workThreadId,
      idempotency_key: "cross-tenant-context",
    });
    expect(context.status).toBe(404);
    const handoff = await call("/v1/handoffs", {
      work_thread_id: workThreadId,
      to_agent_identity_id: otherAgentId,
      instruction: "Steal this work",
      idempotency_key: "cross-tenant-handoff",
    });
    expect(handoff.status).toBe(403);

    await db.query(`DELETE FROM workspaces WHERE id = $1`, [otherWorkspaceId]);
  });

  it("creates, hands off, resolves, receipts, and records an outcome", async () => {
    const app = createApp(db, pepper, {
      authenticateHuman: async (token) =>
        token === "human-session" ? { userId: ownerUserId } : null,
    });
    const call = (path: string, token: string, body: Record<string, unknown>) => app.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ schema_version: TERMYTE_PROTOCOL_VERSION, ...body }),
    });
    const createdResponse = await call("/v1/work", allowedToken, {
      title: "Refresh cookie rotation",
      objective: "Return the new refresh cookie without changing session expiry",
      repository_key: "termyte-labs/app",
      agent_session_id: "claude-origin",
      idempotency_key: "create-work-flow",
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as any;
    const id = created.work_thread.id as string;

    const handoffResponse = await call("/v1/handoffs", allowedToken, {
      work_thread_id: id,
      to_agent_identity_id: claudeAgentId,
      instruction: "Continue fixing the authentication bug",
      idempotency_key: "handoff-flow",
    });
    expect(handoffResponse.status).toBe(201);
    const handoff = await handoffResponse.json() as any;

    const forbiddenBeforeClaim = await call("/v1/context/resolve", claudeToken, {
      request_text: "Fix that auth bug",
      agent_session_id: "claude-fresh",
      work_thread_id: id,
      idempotency_key: "resolve-too-early",
    });
    expect(forbiddenBeforeClaim.status).toBe(404);

    const resolvedResponse = await call("/v1/context/resolve", claudeToken, {
      request_text: "Fix that auth bug",
      agent_session_id: "claude-fresh",
      handoff_id: handoff.handoff.id,
      idempotency_key: "resolve-flow",
    });
    expect(resolvedResponse.status).toBe(200);
    const resolved = await resolvedResponse.json() as any;
    expect(resolved.state).toBe("resolved");
    expect(resolved.briefing).toContain("Return the new refresh cookie");

    const event = await call("/v1/events/batch", claudeToken, {
      events: [{
        event_id: "event:failed-attempt",
        event_type: "failure",
        agent_session_id: "claude-fresh",
        work_thread_id: id,
        occurred_at: Date.now(),
        source: { platform: "claude-code" },
        content: "Updating only the response body did not rotate the cookie",
      }, {
        event_id: "event:session-finished",
        event_type: "session_ended",
        agent_session_id: "claude-fresh",
        work_thread_id: id,
        occurred_at: Date.now(),
        source: { platform: "claude-code" },
        content: "Implemented cookie rotation; verification is still required",
      }],
    });
    expect(event.status).toBe(200);
    let drained = 0;
    while (drained < 10 && await runOneJob(db, "test-worker")) drained += 1;
    expect(drained).toBeGreaterThan(0);

    const updatedRequest = {
      request_text: "Continue fixing that auth bug",
      agent_session_id: "claude-fresh",
      work_thread_id: id,
      idempotency_key: "resolve-updated-flow",
    };
    const updatedResponse = await call("/v1/context/resolve", claudeToken, updatedRequest);
    const updated = await updatedResponse.json() as any;
    expect(updated.briefing).toContain("Updating only the response body did not rotate the cookie");
    expect(updated.briefing).toContain(
      "Agent final response: Implemented cookie rotation; verification is still required",
    );
    expect(updated.sources).toHaveLength(2);
    const replayedResolve = await call("/v1/context/resolve", claudeToken, updatedRequest);
    expect((await replayedResolve.json() as any).receipt_id).toBe(updated.receipt_id);

    const receipt = await call(`/v1/receipts/${updated.receipt_id}/ack`, claudeToken, {
      delivered_at: Date.now(),
      idempotency_key: "ack-flow",
    });
    expect(receipt.status).toBe(200);

    const outcomeReportedAt = Date.now();
    const outcomeResponse = await call("/v1/outcomes", claudeToken, {
      work_thread_id: id,
      receipt_id: updated.receipt_id,
      agent_session_id: "claude-fresh",
      status: "succeeded",
      summary: "Rotated the refresh cookie and preserved session expiry",
      evidence: [{
        kind: "test",
        content: "Authentication integration test passed",
      }],
      reported_at: outcomeReportedAt,
      idempotency_key: "outcome-flow",
    });
    const outcome = await outcomeResponse.json() as any;
    expect(outcomeResponse.status, JSON.stringify(outcome)).toBe(201);
    expect(outcome).toMatchObject({ work_thread_version: 4 });
    expect((await call("/v1/outcomes", claudeToken, {
      work_thread_id: id,
      receipt_id: updated.receipt_id,
      agent_session_id: "claude-fresh",
      status: "succeeded",
      summary: "Rotated the refresh cookie and preserved session expiry",
      evidence: [{ kind: "agent_statement", content: "Changed replay evidence" }],
      reported_at: outcomeReportedAt,
      idempotency_key: "outcome-flow",
    })).status).toBe(409);

    const rows = await db.query(`
      SELECT h.status AS handoff_status, w.status AS work_status, w.current_summary, cr.acknowledged_at
      FROM handoffs h
      JOIN work_threads w ON w.id = h.work_thread_id
      JOIN context_receipts cr ON cr.work_thread_id = w.id
      WHERE h.id = $1 AND cr.id = $2
    `, [handoff.handoff.id, updated.receipt_id]);
    expect(rows.rows[0]).toMatchObject({
      handoff_status: "completed",
      work_status: "completed",
      current_summary: "Rotated the refresh cookie and preserved session expiry",
    });
    expect(rows.rows[0].acknowledged_at).not.toBeNull();

    const reviewHandoffResponse = await call("/v1/handoffs", claudeToken, {
      work_thread_id: id,
      to_agent_identity_id: reviewAgentId,
      instruction: "Review the completed authentication fix",
      idempotency_key: "review-handoff-flow",
    });
    expect(reviewHandoffResponse.status).toBe(201);
    const reviewHandoff = await reviewHandoffResponse.json() as any;
    const reviewContextResponse = await call("/v1/context/resolve", reviewToken, {
      request_text: "Review that auth fix",
      agent_session_id: "opencode-review",
      handoff_id: reviewHandoff.handoff.id,
      idempotency_key: "review-resolve-flow",
    });
    expect(reviewContextResponse.status).toBe(200);
    const reviewContext = await reviewContextResponse.json() as any;
    expect(reviewContext.briefing).toContain(
      "Rotated the refresh cookie and preserved session expiry",
    );
    expect(reviewContext.briefing).toContain(
      "test: Authentication integration test passed",
    );
    const reviewOutcome = await call("/v1/outcomes", reviewToken, {
      work_thread_id: id,
      receipt_id: reviewContext.receipt_id,
      agent_session_id: "opencode-review",
      status: "succeeded",
      summary: "Review passed with authentication integration evidence",
      evidence: [{
        kind: "agent_statement",
        content: "No remaining authentication regression found",
      }],
      reported_at: Date.now(),
      idempotency_key: "review-outcome-flow",
    });
    expect(reviewOutcome.status).toBe(201);
    const reportedReview = await reviewOutcome.json() as any;
    expect((await db.query(`
      SELECT status, current_summary FROM work_threads WHERE id = $1
    `, [id])).rows[0]).toEqual({
      status: "in_review",
      current_summary:
        "Review passed with authentication integration evidence (reported by agent; awaiting confirmation)",
    });
    const confirmed = await app.request(
      `/v1/admin/outcomes/${reportedReview.outcome_id}/confirm`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer human-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspace_id: workspaceId }),
      },
    );
    expect(confirmed.status).toBe(200);
    expect((await db.query(`
      SELECT status, current_summary FROM work_threads WHERE id = $1
    `, [id])).rows[0]).toEqual({
      status: "completed",
      current_summary: "Review passed with authentication integration evidence",
    });
    expect((await db.query<{ action: string }>(`
      SELECT action FROM audit_events
      WHERE workspace_id = $1 AND actor_type = 'agent'
    `, [workspaceId])).rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "work_thread.create",
      "handoff.create",
      "handoff.claim",
      "context.deliver",
      "outcome.report",
    ]));
  });

  it("serves the public Agent SDK contract end to end", async () => {
    const app = createApp(db, pepper);
    const client = new TermyteAgentClient({
      baseUrl: "https://cloud.termyte.test",
      credential: allowedToken,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
    });
    const created = await client.createWork({
      title: "SDK contract",
      objective: "Prove the public SDK and hosted API agree",
      repository_key: "termyte-labs/sdk",
      agent_session_id: "sdk-session",
      idempotency_key: "sdk-create-work",
    });
    expect(created.work_thread).toMatchObject({
      title: "SDK contract",
      status: "active",
      repository_key: "termyte-labs/sdk",
    });
    const events = await client.appendEvents({
      events: [{
        event_id: "sdk-event:1",
        event_type: "observation",
        agent_session_id: "sdk-session",
        work_thread_id: created.work_thread.id,
        occurred_at: Date.now(),
        source: { platform: "codex" },
        content: "The SDK event reached PostgreSQL.",
      }],
    });
    expect(events.accepted_event_ids).toEqual(["sdk-event:1"]);
  });

  it("authorizes a native device once and authenticates its agent sessions", async () => {
    const app = createApp(db, pepper, {
      publicAppUrl: "https://app.termyte.test",
      authenticateHuman: async (token) =>
        token === "human-session" ? { userId: ownerUserId } : null,
    });
    const start = await app.request("/v1/device/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: TERMYTE_PROTOCOL_VERSION,
        device_name: "Palguna laptop",
        platform: "codex",
        requested_scopes: ["events:write", "context:read", "outcomes:write", "handoffs:create", "handoffs:claim"],
      }),
    });
    expect(start.status).toBe(201);
    const flow = await start.json() as any;
    expect(flow.verification_uri_complete).toContain(encodeURIComponent(flow.user_code));

    const poll = () => app.request("/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: TERMYTE_PROTOCOL_VERSION,
        device_code: flow.device_code,
      }),
    });
    expect(await (await poll()).json()).toMatchObject({ state: "pending" });

    const approve = await app.request("/v1/admin/device/approve", {
      method: "POST",
      headers: {
        authorization: "Bearer human-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_code: flow.user_code,
        workspace_id: workspaceId,
        agent_name: "Palguna Codex",
      }),
    });
    expect(approve.status).toBe(200);
    const approval = await approve.json() as any;

    const exchanged = await poll();
    expect(exchanged.status).toBe(200);
    const token = await exchanged.json() as any;
    expect(token).toMatchObject({
      state: "authorized",
      workspace_id: workspaceId,
      agent_identity_id: approval.agent_identity_id,
    });
    expect(token.credential).toMatch(/^tyt_live_/);
    expect((await poll()).status).toBe(409);

    const client = new TermyteAgentClient({
      baseUrl: "https://cloud.termyte.test",
      credential: token.credential,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
    });
    await client.createWork({
      title: "Device-created work",
      objective: "Prove device authentication reaches an agent session",
      agent_session_id: "device-session",
      idempotency_key: "device-created-work",
    });
    const session = await db.query(`
      SELECT credential_id, device_authorization_id
      FROM agent_sessions
      WHERE agent_identity_id = $1 AND source_session_id = 'device-session'
    `, [approval.agent_identity_id]);
    expect(session.rows[0].credential_id).toBeNull();
    expect(session.rows[0].device_authorization_id).not.toBeNull();
  });

  it("lets a human inspect and correct the current Work Thread without rewriting receipts", async () => {
    const app = createApp(db, pepper, {
      authenticateHuman: async (token) =>
        token === "human-session" ? { userId: ownerUserId }
          : token === "other-human" ? { userId: randomUUID() }
            : null,
    });
    const client = new TermyteAgentClient({
      baseUrl: "https://cloud.termyte.test",
      credential: allowedToken,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
    });
    const created = await client.createWork({
      title: "Human correction flow",
      objective: "Keep the correct authentication constraint",
      agent_session_id: "correction-session",
      idempotency_key: "correction-work",
    });
    await client.appendEvents({
      events: [{
        event_id: "correction-event",
        event_type: "constraint",
        agent_session_id: "correction-session",
        work_thread_id: created.work_thread.id,
        occurred_at: Date.now(),
        source: { platform: "codex" },
        content: "Sessions must expire after one hour.",
      }],
    });
    while (await runOneJob(db, "correction-worker")) {
      // Drain the deterministic projection.
    }
    const admin = (path: string, init: RequestInit = {}) => app.request(path, {
      ...init,
      headers: {
        authorization: "Bearer human-session",
        ...(init.headers ?? {}),
      },
    });
    const list = await admin(`/v1/admin/work-threads?workspace_id=${workspaceId}`);
    expect(list.status).toBe(200);
    expect((await list.json() as any).work_threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.work_thread.id, event_count: 1 }),
    ]));
    const detailResponse = await admin(
      `/v1/admin/work-threads/${created.work_thread.id}?workspace_id=${workspaceId}`,
    );
    const detail = await detailResponse.json() as any;
    const item = detail.context_items.find((candidate: any) =>
      candidate.text === "Sessions must expire after one hour.");
    expect(item).toBeTruthy();

    const correctedResponse = await admin(
      `/v1/admin/work-threads/${created.work_thread.id}/context-items/${item.id}/correct`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          action: "edit",
          text: "Sessions must expire after two hours.",
        }),
      },
    );
    expect(correctedResponse.status).toBe(200);
    const resolved = await client.resolveContext({
      request_text: "Continue the correction flow",
      agent_session_id: "correction-session",
      work_thread_id: created.work_thread.id,
      idempotency_key: "corrected-context",
      token_budget: 2_000,
    });
    expect(resolved.state).toBe("resolved");
    if (resolved.state !== "resolved") throw new Error("Expected resolved context");
    expect(resolved.briefing).toContain("Sessions must expire after two hours.");
    expect(resolved.briefing).not.toContain("after one hour.");

    const receipt = await admin(
      `/v1/admin/receipts/${resolved.receipt_id}?workspace_id=${workspaceId}`,
    );
    expect(receipt.status).toBe(200);
    expect((await receipt.json() as any).items[0].source_snapshot_json.text)
      .toBe("Sessions must expire after two hours.");
    const forbidden = await app.request(
      `/v1/admin/work-threads?workspace_id=${workspaceId}`,
      { headers: { authorization: "Bearer other-human" } },
    );
    expect(forbidden.status).toBe(403);
  });

  it("lets owners manage members, identities, credentials, and Work Thread grants", async () => {
    const memberUserId = randomUUID();
    const invitedUserId = randomUUID();
    const app = createApp(db, pepper, {
      authenticateHuman: async (token) =>
        token === "human-session" ? { userId: ownerUserId }
          : token === "member-session" ? { userId: memberUserId }
            : token === "invited-session" ? { userId: invitedUserId }
            : null,
    });
    const admin = (
      path: string,
      method = "GET",
      body?: Record<string, unknown>,
      token = "human-session",
    ) => app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const added = await admin("/v1/admin/members", "POST", {
      workspace_id: workspaceId,
      user_id: memberUserId,
      role: "member",
    });
    expect(added.status).toBe(201);
    expect((await admin(`/v1/admin/members?workspace_id=${workspaceId}`).then(
      (response) => response.json(),
    ) as any).members).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: memberUserId, role: "member" }),
    ]));
    const inviteResponse = await admin("/v1/admin/invites", "POST", {
      workspace_id: workspaceId,
      email: "new.member@example.com",
      role: "member",
    });
    expect(inviteResponse.status).toBe(201);
    const invite = await inviteResponse.json() as any;
    expect(invite).toMatchObject({
      token: expect.stringMatching(/^tyt_inv_/),
      invite_url: expect.stringContaining("/invite?token="),
      email: "new.member@example.com",
    });
    expect((await db.query(`
      SELECT token_hash FROM workspace_invites WHERE id = $1
    `, [invite.id])).rows[0].token_hash).toBeInstanceOf(Buffer);
    expect((await admin("/v1/admin/invites/accept", "POST", {
      token: invite.token,
    }, "invited-session")).status).toBe(200);
    expect((await admin("/v1/admin/invites/accept", "POST", {
      token: invite.token,
    }, "invited-session")).status).toBe(409);
    expect((await admin(`/v1/admin/invites?workspace_id=${workspaceId}`).then(
      (response) => response.json(),
    ) as any).invites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: invite.id,
        accepted_by_user_id: invitedUserId,
      }),
    ]));

    const memberCannotCreate = await admin("/v1/admin/agents", "POST", {
      workspace_id: workspaceId,
      name: "Member agent",
      kind: "codex",
    }, "member-session");
    expect(memberCannotCreate.status).toBe(403);

    const createdAgentResponse = await admin("/v1/admin/agents", "POST", {
      workspace_id: workspaceId,
      name: "Release agent",
      kind: "codex",
    });
    expect(createdAgentResponse.status).toBe(201);
    const createdAgent = await createdAgentResponse.json() as any;

    const credentialResponse = await admin("/v1/admin/credentials", "POST", {
      workspace_id: workspaceId,
      agent_identity_id: createdAgent.id,
      scopes: ["events:write", "context:read"],
    });
    expect(credentialResponse.status).toBe(201);
    const credential = await credentialResponse.json() as any;
    expect(credential.token).toMatch(/^tyt_live_/);

    const releaseClient = new TermyteAgentClient({
      baseUrl: "https://cloud.termyte.test",
      credential: credential.token,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
    });
    const releaseWork = await releaseClient.createWork({
      title: "Credential lifecycle",
      objective: "Prove customer-managed credentials",
      initial_status: "proposed",
      agent_session_id: "release-agent-session",
      idempotency_key: "credential-lifecycle-work",
    });
    expect(releaseWork.work_thread).toMatchObject({
      title: "Credential lifecycle",
      status: "proposed",
    });
    const preview = await admin(
      `/v1/admin/work-threads/${releaseWork.work_thread.id}/preview`,
      "POST",
      {
        workspace_id: workspaceId,
        agent_identity_id: createdAgent.id,
        token_budget: 2_000,
      },
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      work_thread_id: releaseWork.work_thread.id,
      agent_identity_id: createdAgent.id,
      deliverable: true,
      blocked_reason: null,
      briefing: expect.stringContaining("Credential lifecycle"),
    });
    expect((await admin("/v1/admin/context-delivery", "POST", {
      workspace_id: workspaceId,
      target: "agent",
      target_id: createdAgent.id,
      enabled: false,
    })).status).toBe(200);
    expect(await admin(
      `/v1/admin/work-threads/${releaseWork.work_thread.id}/preview`,
      "POST",
      {
        workspace_id: workspaceId,
        agent_identity_id: createdAgent.id,
      },
    ).then((response) => response.json())).toMatchObject({
      deliverable: false,
      blocked_reason: "Context delivery is disabled for the selected Agent Identity.",
      briefing: null,
    });
    expect((await releaseClient.resolveContext({
      request_text: "Continue credential lifecycle",
      work_thread_id: releaseWork.work_thread.id,
      agent_session_id: "release-agent-session",
      idempotency_key: "delivery-disabled",
    })).state).toBe("not_found");
    expect((await admin("/v1/admin/context-delivery", "POST", {
      workspace_id: workspaceId,
      target: "agent",
      target_id: createdAgent.id,
      enabled: true,
    })).status).toBe(200);
    expect((await releaseClient.resolveContext({
      request_text: "Continue credential lifecycle",
      work_thread_id: releaseWork.work_thread.id,
      agent_session_id: "release-agent-session",
      idempotency_key: "delivery-enabled",
    })).state).toBe("resolved");

    const rotatedResponse = await admin(
      `/v1/admin/credentials/${credential.id}/rotate`,
      "POST",
      { workspace_id: workspaceId },
    );
    expect(rotatedResponse.status).toBe(201);
    const rotated = await rotatedResponse.json() as any;
    expect(rotated.token).not.toBe(credential.token);
    expect((await app.request("/v1/work", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    })).status).toBe(401);

    const grantResponse = await admin(
      `/v1/admin/work-threads/${workThreadId}/grants`,
      "POST",
      {
        workspace_id: workspaceId,
        agent_identity_id: deniedAgentId,
        can_read_context: true,
        can_append_events: false,
        can_create_handoff: false,
      },
    );
    expect(grantResponse.status).toBe(201);
    const grant = await grantResponse.json() as any;
    const deniedClient = new TermyteAgentClient({
      baseUrl: "https://cloud.termyte.test",
      credential: deniedToken,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
    });
    expect((await deniedClient.resolveContext({
      request_text: "Continue the auth bug",
      work_thread_id: workThreadId,
      agent_session_id: "human-granted-session",
      idempotency_key: "human-granted-context",
    })).state).toBe("resolved");

    expect((await admin(`/v1/admin/grants/${grant.id}/revoke`, "POST", {
      workspace_id: workspaceId,
    })).status).toBe(200);
    await expect(deniedClient.resolveContext({
      request_text: "Continue the auth bug",
      work_thread_id: workThreadId,
      agent_session_id: "human-granted-session",
      idempotency_key: "after-human-revocation",
    })).rejects.toMatchObject({ status: 404 });

    expect((await admin(`/v1/admin/credentials/${rotated.id}/revoke`, "POST", {
      workspace_id: workspaceId,
    })).status).toBe(200);
    expect((await app.request("/v1/work", {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotated.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    })).status).toBe(401);

    const agents = await admin(`/v1/admin/agents?workspace_id=${workspaceId}`);
    expect((await agents.json() as any)).toMatchObject({
      agents: expect.arrayContaining([expect.objectContaining({ id: createdAgent.id })]),
      credentials: expect.arrayContaining([
        expect.objectContaining({ id: credential.id }),
        expect.objectContaining({ id: rotated.id }),
      ]),
      sessions: expect.any(Array),
      grants: expect.any(Array),
    });
    expect((await admin(`/v1/admin/audit?workspace_id=${workspaceId}`).then(
      (response) => response.json(),
    ) as any).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "context.preview" }),
      expect.objectContaining({ action: "credential.rotate" }),
      expect.objectContaining({ action: "grant.revoke" }),
    ]));
    expect(await admin(`/v1/admin/usage?workspace_id=${workspaceId}`).then(
      (response) => response.json(),
    )).toMatchObject({
      usage: {
        source_events: expect.any(Number),
        context_briefings: expect.any(Number),
        active_work_threads: expect.any(Number),
        agent_identities: expect.any(Number),
      },
      fair_use: {
        source_events_per_month: 250_000,
        context_briefings_per_month: 25_000,
        agent_identities: 100,
        enforcement: "soft",
      },
    });
    expect((await admin(
      `/v1/admin/usage?workspace_id=${workspaceId}`,
      "GET",
      undefined,
      "member-session",
    )).status).toBe(403);

    expect((await admin(
      `/v1/admin/members/${memberUserId}?workspace_id=${workspaceId}`,
      "DELETE",
    )).status).toBe(200);
    expect((await admin(
      `/v1/admin/members/${invitedUserId}?workspace_id=${workspaceId}`,
      "DELETE",
    )).status).toBe(200);
    expect((await admin(
      `/v1/admin/work-threads?workspace_id=${workspaceId}`,
      "GET",
      undefined,
      "member-session",
    )).status).toBe(403);
  });

  it("restricts individual context and safely splits and merges current Work Thread state", async () => {
    const app = createApp(db, pepper, {
      authenticateHuman: async (token) =>
        token === "human-session" ? { userId: ownerUserId } : null,
    });
    const allowedClient = new TermyteAgentClient({
      baseUrl: "https://cloud.termyte.test",
      credential: allowedToken,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
    });
    const deniedClient = new TermyteAgentClient({
      baseUrl: "https://cloud.termyte.test",
      credential: deniedToken,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
    });
    const admin = (path: string, body: Record<string, unknown>) => app.request(path, {
      method: "POST",
      headers: {
        authorization: "Bearer human-session",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const source = await allowedClient.createWork({
      title: "Mixed authentication investigation",
      objective: "Separate the unrelated tenant finding",
      agent_session_id: "split-source-session",
      idempotency_key: "split-source-work",
    });
    await allowedClient.appendEvents({
      events: [{
        event_id: "split-private-finding",
        event_type: "constraint",
        agent_session_id: "split-source-session",
        work_thread_id: source.work_thread.id,
        occurred_at: Date.now(),
        source: { platform: "codex" },
        content: "The tenant secret must stay with the security agent.",
      }, {
        event_id: "split-public-finding",
        event_type: "observation",
        agent_session_id: "split-source-session",
        work_thread_id: source.work_thread.id,
        occurred_at: Date.now(),
        source: { platform: "codex" },
        content: "The public callback uses the wrong hostname.",
      }],
    });
    while (await runOneJob(db, "context-control-worker")) {
      // Materialize both source-backed Context Items.
    }
    const records = await db.query<{
      source_event_id: string;
      context_item_id: string;
    }>(`
      SELECT se.id AS source_event_id, cis.context_item_id
      FROM source_events se
      JOIN context_item_sources cis ON cis.source_event_id = se.id
      WHERE se.workspace_id = $1 AND se.external_id = 'split-private-finding'
    `, [workspaceId]);
    const privateRecord = records.rows[0]!;
    expect((await admin(
      `/v1/admin/work-threads/${source.work_thread.id}/context-items/${privateRecord.context_item_id}/restrict`,
      {
        workspace_id: workspaceId,
        agent_identity_ids: [allowedAgentId],
      },
    )).status).toBe(200);
    const grant = await admin(`/v1/admin/work-threads/${source.work_thread.id}/grants`, {
      workspace_id: workspaceId,
      agent_identity_id: deniedAgentId,
      can_read_context: true,
      can_append_events: false,
      can_create_handoff: false,
    });
    expect(grant.status).toBe(201);
    const hidden = await deniedClient.resolveContext({
      request_text: "Continue the mixed authentication investigation",
      work_thread_id: source.work_thread.id,
      agent_session_id: "restricted-reader",
      idempotency_key: "restricted-context",
      token_budget: 2_000,
    });
    expect(hidden.state).toBe("resolved");
    if (hidden.state !== "resolved") throw new Error("Expected resolved context");
    expect(hidden.briefing).not.toContain("tenant secret");
    expect(hidden.briefing).toContain("wrong hostname");
    expect((await db.query(`
      SELECT resolution_evidence_json FROM context_receipts WHERE id = $1
    `, [hidden.receipt_id])).rows[0].resolution_evidence_json).toMatchObject({
      authorization: {
        agent_identity_id: deniedAgentId,
        credential_id: expect.any(String),
        required_scope: "context:read",
        work_thread_grant: "can_read_context",
      },
      omissions: { restricted: 1 },
    });

    expect((await admin(
      `/v1/admin/work-threads/${source.work_thread.id}/context-items/${privateRecord.context_item_id}/restrict`,
      {
        workspace_id: workspaceId,
        agent_identity_ids: [],
      },
    )).status).toBe(200);
    const visible = await deniedClient.resolveContext({
      request_text: "Continue the mixed authentication investigation",
      work_thread_id: source.work_thread.id,
      agent_session_id: "restricted-reader",
      idempotency_key: "unrestricted-context",
      token_budget: 2_000,
    });
    expect(visible.state).toBe("resolved");
    if (visible.state !== "resolved") throw new Error("Expected resolved context");
    expect(visible.briefing).toContain("tenant secret");

    const splitResponse = await admin(`/v1/admin/work-threads/${source.work_thread.id}/split`, {
      workspace_id: workspaceId,
      title: "Tenant secret constraint",
      objective: "Handle the security-only tenant constraint",
      source_event_ids: [privateRecord.source_event_id],
      idempotency_key: "split-security-work",
    });
    expect(splitResponse.status).toBe(201);
    const split = await splitResponse.json() as any;
    expect((await db.query(`
      SELECT entity.work_thread_id
      FROM source_events event
      JOIN source_entities entity ON entity.id = event.source_entity_id
      WHERE event.id = $1
    `, [privateRecord.source_event_id])).rows[0].work_thread_id).toBe(split.work_thread_id);
    expect((await db.query(`
      SELECT work_thread_id FROM context_items WHERE id = $1
    `, [privateRecord.context_item_id])).rows[0].work_thread_id).toBe(split.work_thread_id);

    const target = await allowedClient.createWork({
      title: "Security consolidation",
      objective: "Keep the final security state in one Work Thread",
      agent_session_id: "merge-target-session",
      idempotency_key: "merge-target-work",
    });
    const merged = await admin(`/v1/admin/work-threads/${split.work_thread_id}/merge`, {
      workspace_id: workspaceId,
      target_work_thread_id: target.work_thread.id,
    });
    expect(merged.status).toBe(200);
    expect((await db.query(`
      SELECT status FROM work_threads WHERE id = $1
    `, [split.work_thread_id])).rows[0].status).toBe("archived");
    expect((await db.query(`
      SELECT work_thread_id FROM context_items WHERE id = $1
    `, [privateRecord.context_item_id])).rows[0].work_thread_id).toBe(target.work_thread.id);
    expect((await db.query(`
      SELECT kind FROM work_thread_links
      WHERE source_work_thread_id = $1 AND target_work_thread_id = $2
    `, [split.work_thread_id, target.work_thread.id])).rows[0].kind).toBe("merged_into");
  });

  it("abstains on unrelated instructions and asks when two permitted Work Threads are ambiguous", async () => {
    const resolverAgentId = randomUUID();
    const issued = issueAgentCredential(pepper);
    await db.query(`
      INSERT INTO agent_identities (
        id, workspace_id, name, kind, created_by_user_id
      ) VALUES ($1, $2, 'Resolver test agent', 'codex', $3)
    `, [resolverAgentId, workspaceId, ownerUserId]);
    await db.query(`
      INSERT INTO agent_credentials (
        id, workspace_id, agent_identity_id, token_prefix, secret_hash,
        scopes, created_by_user_id
      ) VALUES (
        $1, $2, $3, $4, $5,
        ARRAY['events:write','context:read'], $6
      )
    `, [
      randomUUID(),
      workspaceId,
      resolverAgentId,
      issued.prefix,
      issued.secretHash,
      ownerUserId,
    ]);
    const app = createApp(db, pepper, {
      authenticateHuman: async (token) =>
        token === "human-session" ? { userId: ownerUserId } : null,
    });
    const client = new TermyteAgentClient({
      baseUrl: "https://cloud.termyte.test",
      credential: issued.token,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
    });
    const first = await client.createWork({
      title: "Checkout timeout incident",
      objective: "Fix the checkout timeout",
      agent_session_id: "resolver-session",
      idempotency_key: "resolver-first-work",
    });
    expect((await client.resolveContext({
      request_text: "Write the launch announcement",
      agent_session_id: "resolver-session",
      idempotency_key: "resolver-abstain",
    })).state).toBe("not_found");

    await client.createWork({
      title: "Checkout timeout regression",
      objective: "Fix the checkout timeout",
      agent_session_id: "resolver-session",
      idempotency_key: "resolver-second-work",
    });
    const ambiguous = await client.resolveContext({
      request_text: "Continue the checkout timeout",
      agent_session_id: "resolver-session",
      idempotency_key: "resolver-ambiguous",
    });
    expect(ambiguous.state).toBe("clarification_required");
    if (ambiguous.state !== "clarification_required") {
      throw new Error("Expected clarification");
    }
    expect(ambiguous.candidates).toHaveLength(2);
    expect(await client.resolveContext({
      request_text: "Continue the checkout timeout",
      agent_session_id: "resolver-session",
      idempotency_key: "resolver-ambiguous",
    })).toEqual(ambiguous);
    const attemptsResponse = await app.request(
      `/v1/admin/resolution-attempts?workspace_id=${workspaceId}`,
      { headers: { authorization: "Bearer human-session" } },
    );
    expect(attemptsResponse.status).toBe(200);
    const attempts = (await attemptsResponse.json() as any).attempts;
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "not_found" }),
      expect.objectContaining({ state: "clarification_required" }),
    ]));
    const ambiguousAttempt = attempts.find(
      (attempt: any) => attempt.state === "clarification_required",
    );
    expect((await app.request(
      `/v1/admin/resolution-attempts/${ambiguousAttempt.id}/resolve`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer human-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspace_id: workspaceId }),
      },
    )).status).toBe(200);

    const recent = await client.resolveContext({
      request_text: "Continue this work",
      recent_work_thread_ids: [first.work_thread.id],
      agent_session_id: "resolver-session",
      idempotency_key: "resolver-recent",
    });
    expect(recent.state).toBe("resolved");
    if (recent.state !== "resolved") throw new Error("Expected recent work to resolve");
    expect(recent.work_thread_id).toBe(first.work_thread.id);
  });

  it("exports, expires raw detail, deletes source evidence, and deletes a workspace", async () => {
    const app = createApp(db, pepper, {
      authenticateHuman: async (token) =>
        token === "human-session" ? { userId: ownerUserId } : null,
    });
    const client = new TermyteAgentClient({
      baseUrl: "https://cloud.termyte.test",
      credential: allowedToken,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        app.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
    });
    const created = await client.createWork({
      title: "Data control flow",
      objective: "Prove export and deletion controls",
      agent_session_id: "data-session",
      idempotency_key: "data-control-work",
    });
    await client.appendEvents({
      events: [{
        event_id: "deletable-source",
        event_type: "observation",
        agent_session_id: "data-session",
        work_thread_id: created.work_thread.id,
        occurred_at: Date.now(),
        source: { platform: "codex" },
        content: "This source will be deleted.",
      }, {
        event_id: "retained-source",
        event_type: "evidence",
        agent_session_id: "data-session",
        work_thread_id: created.work_thread.id,
        occurred_at: Date.now() - 30 * 24 * 60 * 60_000,
        source: { platform: "codex" },
        content: "Old raw evidence detail.",
      }],
    });
    while (await runOneJob(db, "data-worker")) {
      // Drain projection jobs.
    }
    const admin = (path: string, init: RequestInit = {}) => app.request(path, {
      ...init,
      headers: {
        authorization: "Bearer human-session",
        ...(init.headers ?? {}),
      },
    });
    const exported = await admin(`/v1/admin/workspaces/${workspaceId}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    expect((await exported.json() as any).data.work_threads).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.work_thread.id })]),
    );

    const source = await db.query(`
      SELECT id FROM source_events
      WHERE workspace_id = $1 AND external_id = 'deletable-source'
    `, [workspaceId]);
    const deleted = await admin(
      `/v1/admin/source-events/${source.rows[0].id}?workspace_id=${workspaceId}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    const afterDelete = await client.resolveContext({
      request_text: "Continue data controls",
      agent_session_id: "data-session",
      work_thread_id: created.work_thread.id,
      idempotency_key: "after-source-delete",
      token_budget: 2_000,
    });
    expect(afterDelete.state).toBe("resolved");
    if (afterDelete.state !== "resolved") throw new Error("Expected resolved context");
    expect(afterDelete.briefing).not.toContain("This source will be deleted.");

    const retention = await admin(`/v1/admin/workspaces/${workspaceId}/retention`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retention_days: 7 }),
    });
    expect(retention.status).toBe(200);
    while (await runOneJob(db, "retention-worker")) {
      // Drain the retention job.
    }
    const retained = await db.query(`
      SELECT payload_text, payload_json FROM source_events
      WHERE workspace_id = $1 AND external_id = 'retained-source'
    `, [workspaceId]);
    expect(retained.rows).toHaveLength(0);

    const secondary = await admin("/v1/admin/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Disposable", slug: `disposable-${randomUUID()}` }),
    });
    const secondaryWorkspace = await secondary.json() as any;
    const wrong = await admin(`/v1/admin/workspaces/${secondaryWorkspace.id}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation_slug: "wrong-slug" }),
    });
    expect(wrong.status).toBe(409);
    const scheduled = await admin(`/v1/admin/workspaces/${secondaryWorkspace.id}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation_slug: secondaryWorkspace.slug }),
    });
    expect(scheduled.status).toBe(202);
    expect((await admin("/v1/admin/workspaces").then((response) => response.json()) as any)
      .workspaces.find((workspace: any) => workspace.id === secondaryWorkspace.id))
      .toMatchObject({
        id: secondaryWorkspace.id,
        deletion_requested_at: expect.any(String),
      });
    while (await runOneJob(db, "delete-worker")) {
      // Drain workspace deletion.
    }
    expect((await db.query(`SELECT 1 FROM workspaces WHERE id = $1`, [secondaryWorkspace.id]))
      .rows).toHaveLength(0);
  });

  it("creates Checkout and Portal sessions and applies signed billing events durably", async () => {
    const customersCreate = vi.fn(async () => ({ id: "cus_termyte" }));
    const checkoutCreate = vi.fn(async () => ({
      id: "cs_termyte",
      url: "https://checkout.stripe.test/session",
    }));
    const portalCreate = vi.fn(async () => ({
      url: "https://billing.stripe.test/session",
    }));
    const constructEventAsync = vi.fn(async (body: string) => JSON.parse(body));
    const stripe = {
      customers: { create: customersCreate },
      checkout: { sessions: { create: checkoutCreate } },
      billingPortal: { sessions: { create: portalCreate } },
      webhooks: { constructEventAsync },
    } as unknown as Stripe;
    const app = createApp(db, pepper, {
      publicAppUrl: "https://app.termyte.test",
      authenticateHuman: async (token) =>
        token === "human-session" ? { userId: ownerUserId } : null,
      stripe,
      stripePriceId: "price_founding_team",
      stripeWebhookSecret: "whsec_test",
    });
    const adminPost = (path: string, body: Record<string, unknown>) => app.request(path, {
      method: "POST",
      headers: {
        authorization: "Bearer human-session",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const checkout = await adminPost("/v1/admin/billing/checkout", {
      workspace_id: workspaceId,
    });
    expect(await checkout.json()).toEqual({
      url: "https://checkout.stripe.test/session",
    });
    expect(checkoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription",
      customer: "cus_termyte",
      line_items: [{ price: "price_founding_team", quantity: 1 }],
    }));
    const portal = await adminPost("/v1/admin/billing/portal", {
      workspace_id: workspaceId,
    });
    expect(await portal.json()).toEqual({
      url: "https://billing.stripe.test/session",
    });

    const deliver = (event: Record<string, unknown>) => app.request("/webhooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "signed",
      },
      body: JSON.stringify(event),
    });
    const completed = {
      id: "evt_checkout_completed",
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_termyte",
          subscription: "sub_termyte",
          metadata: { termyte_workspace_id: workspaceId },
        },
      },
    };
    expect((await deliver(completed)).status).toBe(200);
    expect((await deliver(completed)).status).toBe(200);
    while (await runOneJob(db, "stripe-worker")) {
      // Process the idempotent Stripe event.
    }
    expect((await db.query(`
      SELECT subscription_state FROM workspaces WHERE id = $1
    `, [workspaceId])).rows[0].subscription_state).toBe("active");
    expect((await db.query(`
      SELECT COUNT(*)::integer AS n FROM jobs
      WHERE kind = 'stripe_event' AND dedupe_key = 'evt_checkout_completed'
    `)).rows[0].n).toBe(1);

    expect((await deliver({
      id: "evt_payment_failed",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_termyte", subscription: "sub_termyte" } },
    })).status).toBe(200);
    while (await runOneJob(db, "stripe-worker")) {
      // Apply payment failure without deleting customer data.
    }
    expect((await db.query(`
      SELECT subscription_state FROM workspaces WHERE id = $1
    `, [workspaceId])).rows[0].subscription_state).toBe("past_due");
    expect((await db.query(`
      SELECT COUNT(*)::integer AS n FROM work_threads WHERE workspace_id = $1
    `, [workspaceId])).rows[0].n).toBeGreaterThan(0);
    expect(constructEventAsync).toHaveBeenCalledWith(
      expect.any(String),
      "signed",
      "whsec_test",
    );
  });
});
