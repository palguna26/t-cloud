# Termyte Cloud Operations

## Deploy

Termyte Cloud runs as one API service and one background worker against the
same PostgreSQL database. `render.yaml` defines both processes. The API
pre-deploy step applies ordered SQL migrations under an advisory lock before
new code receives traffic. The same API service serves the human dashboard,
so `PUBLIC_APP_URL` must be its public origin.

Required secrets:

- `DATABASE_URL`
- `AGENT_TOKEN_PEPPER` (generated once in the `termyte-shared` environment
  group and shared by the API and worker)
- `PUBLIC_APP_URL`
- `SUPABASE_URL` and `SUPABASE_ANON_KEY`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_ID`
- `METRICS_TOKEN` (generated for authenticated metrics scraping)
- `CONNECTOR_ENCRYPTION_KEY` (exactly 32 random bytes, base64 encoded)
- GitHub: `GITHUB_APP_SLUG` and `GITHUB_WEBHOOK_SECRET`
- Slack: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET`
- Linear: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and
  `LINEAR_WEBHOOK_SECRET`

After deployment:

1. Confirm `GET /health` returns `{"ok":true}`.
2. Add `PUBLIC_APP_URL` and `PUBLIC_APP_URL/invite` to the allowed redirect
   URLs in Supabase Auth, then sign up and create a workspace in the dashboard.
3. Configure Stripe to send events to `/webhooks/stripe`.
4. Configure connector callbacks:
   - GitHub App setup URL:
     `PUBLIC_APP_URL/v1/connectors/oauth/callback?provider=github`
   - GitHub webhook: `PUBLIC_APP_URL/webhooks/connectors/github`
   - Slack OAuth redirect:
     `PUBLIC_APP_URL/v1/connectors/oauth/callback?provider=slack`
   - Slack events: `PUBLIC_APP_URL/webhooks/connectors/slack`
   - Linear OAuth redirect:
     `PUBLIC_APP_URL/v1/connectors/oauth/callback?provider=linear`
   - Linear webhook: `PUBLIC_APP_URL/webhooks/connectors/linear`
5. In Connections, authorize each source and map selected Slack channels and
   Linear teams or projects to repositories. GitHub repository access is
   limited by the GitHub App installation.
6. Run the device authorization flow from a clean Termyte CLI install.
7. Create a Work Thread, hand it off, resolve context from a second agent,
   acknowledge the receipt, and report an outcome.

The API defaults to a 20-connection database pool and the worker to 5.
Lower `DATABASE_POOL_MAX` before adding replicas if their combined maximum
would approach the PostgreSQL connection limit.

## Monitoring and alerts

`GET /metrics` exposes Prometheus text metrics to requests bearing
`Authorization: Bearer $METRICS_TOKEN`. Scrape it from a private monitor and
alert on:

- any `termyte_jobs{state="dead"}` value above zero;
- `termyte_oldest_pending_job_seconds` above 60 for five minutes;
- a five-minute 5xx rate above 1%;
- context-resolution latency above 1.5 seconds at p95;
- `/health` failing twice in succession.

Application logs are structured JSON and include request ID, route, status,
latency, workspace ID, and agent identity when available. Never log request
bodies, context briefings, credentials, or device codes. Use the returned
`x-request-id` to join a customer report to its server log.

When an alert fires, first disable context delivery at workspace, agent, or
Work Thread level if unsafe context might be delivered. Then inspect dead jobs
and request IDs. Re-enable delivery only after the fault is understood.

## Founding-plan operations

The founding plan has soft fair-use limits of 250,000 source events, 25,000
Context Briefings, and 100 active Agent Identities per workspace per month.
The product shows current usage to workspace administrators. It does not
silently charge overages or stop agent work.

Grant a time-limited design-partner override from an operator shell:

```sh
npm run plan:override -- WORKSPACE_UUID founding_partner 2026-12-31 "signed design partner"
```

Use `clear -` to remove it. Every change is written to the workspace audit
log.

## Backup and restore

Enable daily managed PostgreSQL backups before onboarding a paying team.
Also take an encrypted logical backup before destructive migrations:

```sh
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" > termyte.dump
```

Test restoration into a separate database:

```sh
createdb termyte_restore_test
pg_restore --no-owner --no-acl --dbname=termyte_restore_test termyte.dump
psql termyte_restore_test -c "SELECT count(*) FROM workspaces"
```

Never claim a backup is usable until a restore test succeeds.

## Incident controls

- Revoke a compromised device from the workspace Agents endpoint.
- Rotate `AGENT_TOKEN_PEPPER` only with a planned credential reset; existing
  agent and device tokens depend on it.
- A workspace deletion request disables access immediately and is completed
  asynchronously by the worker.
- Failed jobs retry with bounded exponential delay and become `dead` after
  their configured attempt limit. Inspect `jobs.last_error` before replaying.
- Stripe payment failure changes billing state but never deletes customer data.

## Release gate

Before every release:

```sh
npm ci
npm run verify
npm audit --audit-level=high
docker build -t termyte-cloud:release .
```

Apply migrations to a new empty database and run the real PostgreSQL tests.
Then smoke-test `/health` and graceful shutdown from the built container.
