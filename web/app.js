const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const state = { session: JSON.parse(localStorage.getItem("termyte-session") || "null"), workspaces: [], workspace: null, memories: [] };

async function request(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(state.session?.access_token ? { authorization: `Bearer ${state.session.access_token}` } : {}), ...(init.headers || {}) } });
  if (!response.ok) throw new Error((await response.text()) || `Request failed: ${response.status}`);
  return response.json();
}

async function load() {
  state.workspaces = await request("/v1/admin/workspaces");
  state.workspace = state.workspaces[0] ?? null;
  state.memories = state.workspace ? (await request(`/api/admin/memories?workspace_id=${encodeURIComponent(state.workspace.id)}`)).memories : [];
  render();
}

function render() {
  $("#auth").hidden = true;
  $("#app").hidden = false;
  $("#page-eyebrow").textContent = "WORKSPACE ACTIVITY";
  $("#page-title").textContent = "Sources and sessions";
  $("#content").innerHTML = state.workspace
    ? `<section class="section-heading"><div><p class="eyebrow">${escapeHtml(state.workspace.name)}</p><h2>Latest memories</h2><p class="muted">The 50 most recently created memories.</p></div></section>${state.memories.length ? `<div class="panel thread-list">${state.memories.map((memory) => `<article class="thread-row"><div class="thread-row-top"><h3>${escapeHtml(memory.memory_type)}</h3><span class="status ${escapeHtml(memory.status)}">${escapeHtml(memory.status)}</span></div><p>${escapeHtml(String(memory.content).slice(0, 180))}</p><div class="meta-row"><span>${escapeHtml(memory.repository_id || "No repository")}</span><span>${escapeHtml(new Date(memory.event_at).toLocaleString())}</span></div></article>`).join("")}</div>` : `<div class="empty"><h2>Ready for the first memory</h2><p>Connect Slack or GitHub, then start a Codex or Claude Code session.</p></div>`}`
    : `<div class="empty"><h2>Create a workspace</h2><p>Connect Slack and GitHub to start collecting source-backed context.</p></div>`;
}

$("#auth-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const config = await fetch("/app-config.json").then((response) => response.json());
  if (!config.supabase_url) { $("#auth-note").textContent = "Authentication is not configured."; return; }
  const response = await fetch(`${config.supabase_url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: config.supabase_anon_key, "content-type": "application/json" }, body: JSON.stringify({ email: $("#email").value, password: $("#password").value }) });
  if (!response.ok) { $("#auth-note").textContent = "Sign in failed."; return; }
  state.session = await response.json(); localStorage.setItem("termyte-session", JSON.stringify(state.session)); await load();
});
$("#sign-out")?.addEventListener("click", () => { localStorage.removeItem("termyte-session"); location.reload(); });
$("#refresh")?.addEventListener("click", () => load().catch((error) => { $("#content").textContent = error.message; }));
if (state.session) load().catch(() => { $("#content").textContent = "Failed to load memories"; });
