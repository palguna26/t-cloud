import { createHmac, randomUUID } from "node:crypto";

const baseUrl = process.env.TERMYTE_CLOUD_URL ?? "http://localhost:3000";
const secret = process.env.SLACK_SIGNING_SECRET;
if (!secret) throw new Error("SLACK_SIGNING_SECRET is required");
const threadTs = process.env.DEMO_SLACK_THREAD_TS;
if (!threadTs) throw new Error("DEMO_SLACK_THREAD_TS is required");

const timestamp = Math.floor(Date.now() / 1_000);
const body = JSON.stringify({
  type: "event_callback",
  event_id: `Ev-${randomUUID()}`,
  team_id: process.env.DEMO_SLACK_TEAM ?? "T-DEMO",
  event: {
    type: "message",
    channel: process.env.DEMO_SLACK_CHANNEL ?? "C-DEMO",
    ts: threadTs,
    thread_ts: threadTs,
    text: "Sync this Slack thread.",
  },
});
const signature = `v0=${createHmac("sha256", secret)
  .update(`v0:${timestamp}:${body}`)
  .digest("hex")}`;
const response = await fetch(`${baseUrl}/webhooks/connectors/slack`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": signature,
  },
  body,
});
process.stdout.write(`${response.status} ${await response.text()}\n`);
if (!response.ok) process.exitCode = 1;
