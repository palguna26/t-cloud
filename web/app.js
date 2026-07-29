const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const state = { config: {}, workspaces: [], workspace: null, view: "threads", threads: [], thread: null, connectors: { connections: [], mappings: [] }, register: false };

async function request(path, init = {}) {
  const response = await fetch(path, { ...init, credentials: "same-origin", headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error?.message || body.error || `Request failed: ${response.status}`), { status: response.status });
  return body;
}

async function bootstrap() {
  state.config = await request("/app-config.json");
  $("#demo-login").hidden = !state.config.demo_mode;
  try { await loadWorkspaces(); } catch (error) { if (error.status !== 401) note(error.message); }
}

async function loadWorkspaces() {
  state.workspaces = await request("/v1/admin/workspaces");
  const saved = localStorage.getItem("termyte-workspace");
  state.workspace = state.workspaces.find(({ id }) => id === saved) || state.workspaces[0] || null;
  $("#auth").hidden = true;
  $("#app").hidden = false;
  await loadView();
}

async function loadView() {
  if (!state.workspace) return renderWorkspaceSetup();
  localStorage.setItem("termyte-workspace", state.workspace.id);
  if (state.view === "threads") {
    state.threads = await request(`/v1/admin/work-threads?workspace_id=${encodeURIComponent(state.workspace.id)}`);
    if (state.thread && !state.threads.some(({ id }) => id === state.thread.id)) state.thread = null;
  } else {
    state.connectors = await request(`/v1/admin/connectors?workspace_id=${encodeURIComponent(state.workspace.id)}`);
  }
  render();
}

function render() {
  $("#workspace-select").innerHTML = state.workspaces.map((workspace) => `<option value="${escapeHtml(workspace.id)}" ${workspace.id === state.workspace?.id ? "selected" : ""}>${escapeHtml(workspace.name)}</option>`).join("");
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  $("#page-eyebrow").textContent = state.view === "threads" ? "AGENT CONTEXT" : "SOURCE SETUP";
  $("#page-title").textContent = state.view === "threads" ? "Work Threads" : "Connections";
  $("#content").innerHTML = state.view === "threads" ? renderThreads() : renderConnections();
}

function renderWorkspaceSetup() {
  $("#auth").hidden = true;
  $("#app").hidden = false;
  $("#workspace-select").innerHTML = '<option value="">No workspace</option>';
  $("#content").innerHTML = `<div class="panel settings-section"><p class="eyebrow">FIRST STEP</p><h2>Create your workspace</h2><p>This keeps each company's sources and agent context separate.</p><form id="workspace-form" class="modal-form"><label>Name<input id="workspace-name" required placeholder="Acme Engineering"></label><button class="primary" type="submit">Create workspace</button></form></div>`;
}

function renderThreads() {
  if (!state.threads.length) return `<div class="empty"><div class="empty-mark">W</div><h2>No Work Threads yet</h2><p>Connect Linear, Slack, and GitHub. A Linear issue becomes a Work Thread when its webhook arrives.</p><button class="primary" data-action="connections" type="button">Set up connections</button></div>`;
  const selected = state.thread || state.threads[0];
  if (!state.thread) queueMicrotask(() => openThread(selected.id));
  return `<div class="view-grid"><div class="panel thread-list">${state.threads.map((thread) => `<button class="thread-row ${thread.id === selected.id ? "active" : ""}" data-thread="${escapeHtml(thread.id)}" type="button"><div class="thread-row-top"><h3>${escapeHtml(thread.linear_issue_key)} · ${escapeHtml(thread.title)}</h3><span class="status ${escapeHtml(thread.status)}">${escapeHtml(thread.status)}</span></div><p>${escapeHtml(thread.repository_id || "Repository not linked")}</p><div class="meta-row"><span>${thread.claim_count} claims</span><span>${thread.evidence_count} sources</span></div></button>`).join("")}</div><section class="panel detail">${state.thread ? renderThreadDetail(state.thread) : '<div class="loading"></div>'}</section></div>`;
}

function renderThreadDetail(thread) {
  return `<div class="detail-hero"><p class="eyebrow">${escapeHtml(thread.linear_issue_key)} · VERSION ${thread.version}</p><h2>${escapeHtml(thread.title)}</h2><p>${escapeHtml(thread.repository_id || "Repository not linked")}</p></div><div class="detail-body"><div class="section-heading"><div><h3>Agent briefing evidence</h3><p>Each claim stays linked to its source.</p></div></div><div class="stack">${thread.claims.length ? thread.claims.map((claim) => `<article class="context-item"><div class="item-top"><span class="context-type">${escapeHtml(claim.claim_type)} · ${escapeHtml(claim.source_type)}</span><span class="status ${escapeHtml(claim.status)}">${escapeHtml(claim.status)}</span></div><p>${escapeHtml(claim.content)}</p><small class="source-note">${sourceLink(claim.source_url, "Open source")} · ${formatDate(claim.event_at)}</small></article>`).join("") : '<p class="muted">No claims have been linked yet.</p>'}</div><div class="section-heading wide-panel"><div><h3>Context receipts</h3><p>Proof that an agent received this Work Thread version.</p></div></div><div class="stack">${thread.receipts.length ? thread.receipts.map((receipt) => `<article class="receipt"><div class="receipt-top"><strong>Version ${receipt.work_thread_version}</strong><span class="status ${escapeHtml(receipt.delivery_status || "pending")}">${escapeHtml(receipt.delivery_status || "pending")}</span></div><small>${receipt.acknowledged_at ? `Acknowledged ${formatDate(receipt.acknowledged_at)}` : `Expires ${formatDate(receipt.expires_at)}`}</small></article>`).join("") : '<p class="muted">No agent has requested this context yet.</p>'}</div></div>`;
}

function renderConnections() {
  const providers = ["linear", "slack", "github"];
  return `<section class="section-heading"><div><h2>Connect the three context sources</h2><p>Linear defines the task. Slack adds decisions. GitHub adds implementation history.</p></div></section><div class="cards">${providers.map((provider) => { const connection = state.connectors.connections.find((item) => item.provider === provider && item.status !== "revoked"); const configured = state.config.connectors?.includes(provider); const mappings = connection ? state.connectors.mappings.filter((item) => item.connector_connection_id === connection.id) : []; return `<article class="panel metric"><span>${escapeHtml(provider.toUpperCase())}</span><strong>${connection ? escapeHtml(connection.name) : configured ? "Not connected" : "Needs server setup"}</strong><p class="muted">${connection ? `${mappings.length} scope mapping${mappings.length === 1 ? "" : "s"}` : configured ? "Required for the pilot context loop." : `Add the ${provider} app credentials to Termyte Cloud.`}</p><div class="button-row">${connection ? `<button class="secondary" data-map="${escapeHtml(connection.id)}" type="button">Map scope</button><button class="danger" data-revoke="${escapeHtml(connection.id)}" type="button">Disconnect</button>` : configured ? `<button class="primary" data-connect="${provider}" type="button">Connect ${escapeHtml(provider)}</button>` : ""}</div></article>`; }).join("")}</div><div class="callout wide-panel">After connecting, configure each provider webhook to the matching <code>/webhooks/linear</code>, <code>/webhooks/slack</code>, or <code>/webhooks/github</code> endpoint.</div>`;
}

async function openThread(id) {
  state.thread = await request(`/v1/admin/work-threads/${encodeURIComponent(id)}?workspace_id=${encodeURIComponent(state.workspace.id)}`);
  render();
}

function sourceLink(value, label) { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? `<a href="${escapeHtml(url.href)}" target="_blank" rel="noreferrer">${label}</a>` : "Source recorded"; } catch { return "Source recorded"; } }
function formatDate(value) { return value ? new Date(value).toLocaleString() : "Not recorded"; }
function note(message) { $("#auth-note").textContent = message; }

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault(); note("");
  try {
    const result = await request(`/auth/${state.register ? "register" : "login"}`, { method: "POST", body: JSON.stringify({ email: $("#email").value, password: $("#password").value }) });
    if (result.pending_confirmation) return note("Check your email, then sign in.");
    $("#user-email").textContent = $("#email").value;
    await loadWorkspaces();
  } catch (error) { note(error.message); }
});
$("#auth-mode").addEventListener("click", () => { state.register = !state.register; $("#auth-submit").textContent = state.register ? "Create account" : "Sign in"; $("#auth-mode").textContent = state.register ? "Sign in instead" : "Create an account instead"; note(""); });
$("#demo-login").addEventListener("click", async () => { await request("/auth/demo", { method: "POST" }); await loadWorkspaces(); });
$("#sign-out").addEventListener("click", async () => { await request("/auth/logout", { method: "POST" }); localStorage.removeItem("termyte-workspace"); location.reload(); });
$("#workspace-select").addEventListener("change", async (event) => { state.workspace = state.workspaces.find(({ id }) => id === event.target.value); state.thread = null; await loadView(); });
$("#refresh").addEventListener("click", () => loadView().catch((error) => { $("#content").textContent = error.message; }));
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-view],[data-action],[data-thread],[data-connect],[data-map],[data-revoke]"); if (!target) return;
  try {
    if (target.dataset.view || target.dataset.action === "connections") { state.view = target.dataset.view || "connections"; state.thread = null; return await loadView(); }
    if (target.dataset.thread) return await openThread(target.dataset.thread);
    if (target.dataset.connect) { const result = await request(`/v1/admin/connectors/${target.dataset.connect}/start?workspace_id=${encodeURIComponent(state.workspace.id)}`, { method: "POST" }); return location.assign(result.authorization_url); }
    if (target.dataset.map) { const external_scope_id = prompt("Provider scope ID (Slack channel, Linear team, or GitHub repository ID)"); if (!external_scope_id) return; const external_scope_name = prompt("Scope name") || external_scope_id; const repository_key = prompt("GitHub repository key, for example github.com/acme/app"); if (!repository_key) return; await request(`/v1/admin/connectors/${target.dataset.map}/scopes?workspace_id=${encodeURIComponent(state.workspace.id)}`, { method: "POST", body: JSON.stringify({ external_scope_id, external_scope_name, repository_key }) }); return await loadView(); }
    if (target.dataset.revoke && confirm("Disconnect this source?")) { await request(`/v1/admin/connectors/${target.dataset.revoke}/revoke?workspace_id=${encodeURIComponent(state.workspace.id)}`, { method: "POST" }); return await loadView(); }
  } catch (error) { $("#content").textContent = error.message; }
});
document.addEventListener("submit", async (event) => { if (event.target.id !== "workspace-form") return; event.preventDefault(); const name = $("#workspace-name").value.trim(); const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${crypto.randomUUID().slice(0, 6)}`; await request("/v1/admin/workspaces", { method: "POST", body: JSON.stringify({ name, slug }) }); await loadWorkspaces(); });

bootstrap().catch((error) => note(error.message));
