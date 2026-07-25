import { createHmac } from "node:crypto";

const baseUrl = process.env.TERMYTE_CLOUD_URL ?? "http://localhost:3000";
const secret = process.env.SLACK_SIGNING_SECRET;
if (!secret) throw new Error("SLACK_SIGNING_SECRET is required");

const timestamp = Math.floor(Date.now() / 1_000);
const body = JSON.stringify({
  type: "event_callback",
  team_id: process.env.DEMO_SLACK_TEAM ?? "T-DEMO",
  event: {
    type: "message",
    channel: process.env.DEMO_SLACK_CHANNEL ?? "C-DEMO",
    ts: `${timestamp}.000001`,
    text: [
      "Auth bug: Customer login fails after session refresh.",
      "The refresh cookie is not rotated.",
      "Return a new refresh cookie without ending the current session.",
      "Changing only the response body did not solve it.",
    ].join("\n"),
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
