const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const state = { session: JSON.parse(localStorage.getItem("termyte-session") || "null"), workspaces: [], workspace: null };

async function request(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(state.session?.access_token ? { authorization: `Bearer ${state.session.access_token}` } : {}), ...(init.headers || {}) } });
  if (!response.ok) throw new Error((await response.text()) || `Request failed: ${response.status}`);
  return response.json();
}

async function load() {
  state.workspaces = await request("/v1/admin/workspaces");
  state.workspace = state.workspaces[0] ?? null;
  render();
}

function render() {
  $("#auth").hidden = true;
  $("#app").hidden = false;
  $("#page-eyebrow").textContent = "WORKSPACE ACTIVITY";
  $("#page-title").textContent = "Sources and sessions";
  $("#content").innerHTML = state.workspace
    ? `<section class="section-heading"><div><p class="eyebrow">${escapeHtml(state.workspace.name)}</p><h2>Connected context</h2><p class="muted">Slack and GitHub records, followed by coding-agent sessions.</p></div></section><div class="empty"><h2>Ready for the first sync</h2><p>Connect Slack or GitHub, then start a Codex or Claude Code session.</p></div>`
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
if (state.session) load().catch((error) => { $("#content").textContent = error.message; });
