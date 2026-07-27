import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptCredentials,
  encryptCredentials,
  normalizeConnectorWebhook,
  verifyConnectorWebhook,
} from "../src/connectors.js";

describe("connector security", () => {
  it("encrypts credentials with authenticated encryption", () => {
    const key = randomBytes(32);
    const encrypted = encryptCredentials(key, {
      access_token: "secret-token",
      refresh_token: "refresh-token",
    });
    expect(encrypted.toString()).not.toContain("secret-token");
    expect(decryptCredentials(key, encrypted)).toEqual({
      access_token: "secret-token",
      refresh_token: "refresh-token",
    });
    encrypted[encrypted.length - 1]! ^= 1;
    expect(() => decryptCredentials(key, encrypted)).toThrow();
  });

  it("verifies GitHub signatures over the raw request body", () => {
    const body = JSON.stringify({ action: "opened" });
    const secret = "github-webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyConnectorWebhook(
      "github",
      body,
      new Headers({ "x-hub-signature-256": signature }),
      secret,
    )).toBe(true);
    expect(verifyConnectorWebhook(
      "github",
      `${body} `,
      new Headers({ "x-hub-signature-256": signature }),
      secret,
    )).toBe(false);
  });

  it("verifies Slack signatures and rejects stale requests", () => {
    const now = 1_800_000_000_000;
    const timestamp = String(now / 1_000);
    const body = JSON.stringify({ type: "event_callback" });
    const secret = "slack-signing-secret";
    const signature = `v0=${createHmac("sha256", secret)
      .update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const headers = new Headers({
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    });
    expect(verifyConnectorWebhook("slack", body, headers, secret, now)).toBe(true);
    expect(verifyConnectorWebhook("slack", body, headers, secret, now + 301_000)).toBe(false);
  });

});

describe("connector normalization", () => {
  it("normalizes GitHub issues with repository identity", () => {
    const event = normalizeConnectorWebhook("github", {
      action: "opened",
      installation: { id: 42 },
      repository: { id: 7, full_name: "termyte/app" },
      issue: {
        id: 9,
        title: "Authentication fails after refresh",
        body: "The refresh cookie is stale.",
        html_url: "https://github.com/termyte/app/issues/1",
        created_at: "2026-07-24T00:00:00Z",
      },
    }, new Headers({
      "x-github-event": "issues",
      "x-github-delivery": "delivery-1",
    }));
    expect(event).toMatchObject({
      externalAccountId: "42",
      externalId: "issues:9",
      entityKey: "issues:9",
      providerEventId: "delivery-1",
      repositoryKey: "github.com/termyte/app",
      externalScopeId: "7",
      title: "Authentication fails after refresh",
    });
  });

  it("normalizes Slack messages as scoped organizational observations", () => {
    const event = normalizeConnectorWebhook("slack", {
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        channel: "C1",
        ts: "1800000000.000001",
        text: "Customer cannot sign in after refreshing.",
      },
    }, new Headers());
    expect(event).toMatchObject({
      externalAccountId: "T1",
      externalId: "T1:C1:1800000000.000001",
      externalScopeId: "C1",
      entityKey: "T1:C1:1800000000.000001",
      eventType: "observation",
      title: "Customer cannot sign in after refreshing.",
    });
  });

  it("ignores Slack bots and groups edits with their root thread", () => {
    const base = {
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        channel: "C1",
        ts: "1800000000.000001",
        text: "Ignore me",
      },
    };
    expect(normalizeConnectorWebhook("slack", {
      ...base,
      event: { ...base.event, bot_id: "B1" },
    }, new Headers())).toBeNull();
    const edited = normalizeConnectorWebhook("slack", {
      ...base,
      event_id: "Ev-edit",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        event_ts: "1800000002.000001",
        message: {
          ts: "1800000001.000001",
          thread_ts: "1800000000.000001",
          text: "Edited reply",
          edited: { ts: "1800000002.000001" },
        },
      },
    }, new Headers());
    expect(edited).toMatchObject({
      entityKey: "T1:C1:1800000000.000001",
      providerEventId: "Ev-edit",
      text: "Edited reply",
    });
  });

});
