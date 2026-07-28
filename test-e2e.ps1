$ErrorActionPreference = "Stop"
$Container = "termyte-cloud-e2e-db"
$Port = 3210
$env:DATABASE_URL = "postgres://postgres:postgres@localhost:55432/termyte_e2e"
$env:AGENT_TOKEN_PEPPER = "e2e-agent-token-pepper-at-least-32-bytes"
$env:CONNECTOR_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
$env:GITHUB_WEBHOOK_SECRET = "e2e-github-secret"
$env:SLACK_SIGNING_SECRET = "e2e-slack-signing-secret"
$env:PORT = "$Port"
$env:PUBLIC_APP_URL = "http://localhost:$Port"
$AgentToken = "tyt_live_0123456789abcdef01_$('a' * 43)"
$Server = $null
$Log = Join-Path $env:TEMP "termyte-cloud-e2e.log"
$ErrorLog = Join-Path $env:TEMP "termyte-cloud-e2e-error.log"

function Sign-Hmac([string]$Secret, [string]$Text) {
  $Hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Secret))
  try { return ([BitConverter]::ToString($Hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace("-", "").ToLowerInvariant() } finally { $Hmac.Dispose() }
}

try {
  docker ps -aq --filter "name=^/$Container$" | ForEach-Object { docker rm -f $_ | Out-Null }
  docker run --name $Container -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=termyte_e2e -p 55432:5432 -d postgres:16-alpine | Out-Null
  for ($i = 0; $i -lt 30; $i++) { docker exec $Container pg_isready -U postgres *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 1 }
  if ($LASTEXITCODE -ne 0) { throw "Postgres did not become ready" }
  npm run db:migrate
  node scripts/e2e-db.mjs setup
  $Server = Start-Process node -ArgumentList "dist/server.js" -PassThru -NoNewWindow -RedirectStandardOutput $Log -RedirectStandardError $ErrorLog
  Start-Sleep -Seconds 3

  $GithubPayload = '{"action":"opened","installation":{"id":12345},"repository":{"id":99,"full_name":"owner/repo","html_url":"https://github.com/owner/repo"},"issue":{"id":123,"title":"Bug 123","body":"fix the bug","html_url":"https://github.com/owner/repo/issues/123","created_at":"2026-07-28T10:00:00Z","updated_at":"2026-07-28T10:00:00Z"}}'
  $Github = Invoke-WebRequest "http://localhost:$Port/webhooks/github" -UseBasicParsing -Method Post -ContentType "application/json" -Headers @{ "x-github-event"="issues"; "x-github-delivery"="e2e-github-1"; "x-hub-signature-256"="sha256=$(Sign-Hmac $env:GITHUB_WEBHOOK_SECRET $GithubPayload)" } -Body $GithubPayload
  if ($Github.StatusCode -ne 200) { throw "GitHub webhook returned $($Github.StatusCode)" }
  Write-Output "GitHub webhook: 200 OK"

  $Timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $SlackPayload = "{`"type`":`"event_callback`",`"team_id`":`"T123`",`"event_id`":`"e2e-slack-1`",`"event`":{`"type`":`"message`",`"channel`":`"C123`",`"user`":`"U123`",`"ts`":`"$Timestamp.000000`",`"event_ts`":`"$Timestamp.000000`",`"text`":`"Check out github.com/owner/repo/issues/123`"}}"
  $SlackSignature = Sign-Hmac $env:SLACK_SIGNING_SECRET "v0:$Timestamp`:$SlackPayload"
  $Slack = Invoke-WebRequest "http://localhost:$Port/webhooks/slack" -UseBasicParsing -Method Post -ContentType "application/json" -Headers @{ "x-slack-request-timestamp"="$Timestamp"; "x-slack-signature"="v0=$SlackSignature" } -Body $SlackPayload
  if ($Slack.StatusCode -ne 200) { throw "Slack webhook returned $($Slack.StatusCode)" }
  Write-Output "Slack webhook: 200 OK"

  node scripts/e2e-db.mjs verify
  $Context = Invoke-RestMethod "http://localhost:$Port/api/v1/context" -Method Post -ContentType "application/json" -Headers @{ Authorization="Bearer $AgentToken" } -Body '{"task":"fix the bug","repository":"owner/repo"}'
  if ($null -eq $Context.briefing) { throw "Context response has no briefing key" }
  $Context | ConvertTo-Json -Depth 8
} catch {
  if (Test-Path $Log) { Get-Content $Log }
  if (Test-Path $ErrorLog) { Get-Content $ErrorLog }
  throw
} finally {
  if ($Server -and -not $Server.HasExited) { Stop-Process -Id $Server.Id -Force }
  docker ps -aq --filter "name=^/$Container$" | ForEach-Object { docker rm -f $_ | Out-Null }
}
