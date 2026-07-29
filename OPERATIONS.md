# Termyte Cloud Operations

## Deploy

Termyte Cloud runs an API and a worker against PostgreSQL. Run the ordered SQL migrations before starting either process.

Required configuration:

- `DATABASE_URL`
- `AGENT_TOKEN_PEPPER`
- `PUBLIC_APP_URL`

For human login, set `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Supabase credentials stay on the server; the browser receives an HttpOnly session cookie.

For connectors, set a base64-encoded 32-byte `CONNECTOR_ENCRYPTION_KEY` plus the provider values you enable:

- GitHub: `GITHUB_APP_SLUG` and `GITHUB_WEBHOOK_SECRET`
- Slack: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET`
- Linear: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and `LINEAR_WEBHOOK_SECRET`

The API can start without connector configuration. The dashboard then shows which provider credentials are missing.

## Pilot setup

1. Confirm `GET /health` returns `{"ok":true}`.
2. Sign in and create a workspace.
3. Configure OAuth callbacks at `/v1/connectors/oauth/callback?provider=github|slack|linear`.
4. Configure provider webhooks at `/webhooks/github`, `/webhooks/slack`, and `/webhooks/linear`.
5. Connect Linear, Slack, and GitHub in the dashboard.
6. Map Linear teams and selected Slack channels to a GitHub repository key such as `github.com/acme/app`.
7. Run `termyte connect` from Codex or Claude Code and approve the device.
8. Ask the agent to work on an explicit Linear key such as `LIN-42`.

A Linear issue creates the Work Thread. Explicit Linear keys and source URLs attach Slack and GitHub evidence. The dashboard shows claims, source links, and context receipts.

## Monitoring

`GET /metrics` exposes Prometheus text. If `METRICS_TOKEN` is configured, send it as `Authorization: Bearer <token>`.

Monitor:

- `/health` failures;
- API 5xx responses;
- pending or failed `alpha_sync_jobs`;
- old pending jobs;
- context-resolution latency.

Do not log request bodies, context briefings, credentials, or device codes. Use `x-request-id` to trace failed requests.

## Backup and restore

Enable managed PostgreSQL backups before onboarding a pilot. Test restore into a separate database before relying on a backup.

```sh
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" > termyte.dump
createdb termyte_restore_test
pg_restore --no-owner --no-acl --dbname=termyte_restore_test termyte.dump
psql termyte_restore_test -c "SELECT count(*) FROM workspaces"
```

## Release gate

```sh
npm ci
npm run verify
npm audit --audit-level=high
docker build -t termyte-cloud:release .
```

Also apply migrations to a new empty PostgreSQL database, run `npm run test:db`, and browser-test login, workspace creation, Connections, Work Threads, source links, receipts, mobile layout, and sign-out.
