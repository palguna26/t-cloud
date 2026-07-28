#!/usr/bin/env bash
set -euo pipefail

container=termyte-cloud-e2e-db
port=3210
export DATABASE_URL=postgres://postgres:postgres@localhost:55432/termyte_e2e
export AGENT_TOKEN_PEPPER=e2e-agent-token-pepper-at-least-32-bytes
export CONNECTOR_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export GITHUB_WEBHOOK_SECRET=e2e-github-secret
export SLACK_SIGNING_SECRET=e2e-slack-signing-secret
export PORT=$port PUBLIC_APP_URL=http://localhost:$port
agent_token="tyt_live_0123456789abcdef01_$(printf 'a%.0s' {1..43})"
log="${TMPDIR:-/tmp}/termyte-cloud-e2e.log"
server_pid=
cleanup() { [[ -z "$server_pid" ]] || kill "$server_pid" 2>/dev/null || true; docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker rm -f "$container" >/dev/null 2>&1 || true
docker run --name "$container" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termyte_e2e -p 55432:5432 -d postgres:16-alpine >/dev/null
for _ in {1..30}; do docker exec "$container" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$container" pg_isready -U postgres >/dev/null
npm run db:migrate
node scripts/e2e-db.mjs setup
node dist/server.js >"$log" 2>&1 & server_pid=$!
sleep 3

github_payload='{"action":"opened","installation":{"id":12345},"repository":{"id":99,"full_name":"owner/repo","html_url":"https://github.com/owner/repo"},"issue":{"id":123,"title":"Bug 123","body":"fix the bug","html_url":"https://github.com/owner/repo/issues/123","created_at":"2026-07-28T10:00:00Z","updated_at":"2026-07-28T10:00:00Z"}}'
github_signature=$(PAYLOAD="$github_payload" node -e "const c=require('crypto');process.stdout.write(c.createHmac('sha256',process.env.GITHUB_WEBHOOK_SECRET).update(process.env.PAYLOAD).digest('hex'))")
[[ $(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H 'x-github-event: issues' -H 'x-github-delivery: e2e-github-1' -H "x-hub-signature-256: sha256=$github_signature" --data "$github_payload" "http://localhost:$port/webhooks/github") == 200 ]]
echo 'GitHub webhook: 200 OK'

timestamp=$(date +%s)
slack_payload="{\"type\":\"event_callback\",\"team_id\":\"T123\",\"event_id\":\"e2e-slack-1\",\"event\":{\"type\":\"message\",\"channel\":\"C123\",\"user\":\"U123\",\"ts\":\"$timestamp.000000\",\"event_ts\":\"$timestamp.000000\",\"text\":\"Check out github.com/owner/repo/issues/123\"}}"
slack_signature=$(PAYLOAD="v0:$timestamp:$slack_payload" node -e "const c=require('crypto');process.stdout.write(c.createHmac('sha256',process.env.SLACK_SIGNING_SECRET).update(process.env.PAYLOAD).digest('hex'))")
[[ $(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "x-slack-request-timestamp: $timestamp" -H "x-slack-signature: v0=$slack_signature" --data "$slack_payload" "http://localhost:$port/webhooks/slack") == 200 ]]
echo 'Slack webhook: 200 OK'

node scripts/e2e-db.mjs verify
curl -fsS -H 'content-type: application/json' -H "authorization: Bearer $agent_token" --data '{"task":"fix the bug","repository":"owner/repo"}' "http://localhost:$port/api/v1/context" | tee /dev/stderr | grep -q '"briefing"'
