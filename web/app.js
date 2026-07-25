const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const relativeTime = (value) => {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return "just now";
};

const state = {
  config: null,
  session: JSON.parse(localStorage.getItem("termyte-session") || "null"),
  workspaces: [],
  workspace: null,
  threads: [],
  agents: [],
  connections: [],
  connectorMappings: [],
  connectorLinks: [],
  attempts: [],
  selectedThread: null,
  selectedDetail: null,
  view: "work",
  detailTab: "context",
  signUp: false,
};

const auth = $("#auth");
const app = $("#app");
const content = $("#content");
const modal = $("#modal");

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(state.session?.access_token ? { authorization: `Bearer ${state.session.access_token}` } : {}),
      ...options.headers,
    },
  });
  const body = response.headers.get("content-type")?.includes("json")
    ? await response.json()
    : await response.text();
  if (response.status === 401 && path.startsWith("/v1/")) {
    await refreshSession();
    if (state.session?.access_token && !options.retried) return request(path, { ...options, retried: true });
    signOut();
  }
  if (!response.ok) throw new Error(body?.message || body?.error || `Request failed (${response.status})`);
  return body;
}

async function refreshSession() {
  if (!state.session?.refresh_token || !state.config?.supabase_url) return;
  const response = await fetch(`${state.config.supabase_url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: state.config.supabase_anon_key, "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: state.session.refresh_token }),
  });
  if (response.ok) saveSession(await response.json());
}

function saveSession(session) {
  state.session = session;
  localStorage.setItem("termyte-session", JSON.stringify(session));
}

function signOut() {
  state.session = null;
  localStorage.removeItem("termyte-session");
  app.hidden = true;
  auth.hidden = false;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => element.classList.remove("show"), 2800);
}

function setModal(eyebrow, title, body) {
  $("#modal-eyebrow").textContent = eyebrow;
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = body;
  modal.showModal();
}

function status(value) {
  return `<span class="status ${escapeHtml(value)}">${escapeHtml(value.replaceAll("_", " "))}</span>`;
}

async function initialize() {
  state.config = await fetch("/app-config.json").then((response) => response.json());
  if (state.config.demo_mode) {
    saveSession({ access_token: "demo", user: { email: "demo@termyte.local" } });
    await enterApp();
    return;
  }
  const inviteToken = new URLSearchParams(location.search).get("token");
  if (inviteToken) localStorage.setItem("termyte-invite", inviteToken);
  if (!state.config.supabase_url) {
    $("#auth-note").textContent = "Sign-in is not configured on this server.";
    return;
  }
  if (state.session?.expires_at && state.session.expires_at * 1000 < Date.now() + 30_000) await refreshSession();
  if (state.session?.access_token) {
    try {
      await enterApp();
      return;
    } catch {
      signOut();
    }
  }
}

async function enterApp() {
  auth.hidden = true;
  app.hidden = false;
  $("#user-email").textContent = state.session.user?.email || "Signed in";
  const result = await request("/v1/admin/workspaces");
  state.workspaces = result.workspaces;
  await acceptPendingInvite();
  if (!state.workspaces.length) return renderOnboarding();
  const remembered = localStorage.getItem("termyte-workspace");
  state.workspace = state.workspace
    || state.workspaces.find((workspace) => workspace.id === remembered)
    || state.workspaces[0];
  renderWorkspacePicker();
  await loadWorkspace();
  if (location.pathname === "/device") openDeviceApproval();
}

async function acceptPendingInvite() {
  const token = localStorage.getItem("termyte-invite");
  if (!token) return;
  try {
    const accepted = await request("/v1/admin/invites/accept", {
      method: "POST", body: JSON.stringify({ token }),
    });
    localStorage.removeItem("termyte-invite");
    const result = await request("/v1/admin/workspaces");
    state.workspaces = result.workspaces;
    state.workspace = state.workspaces.find((workspace) => workspace.id === accepted.workspace_id) || state.workspace;
    renderWorkspacePicker();
    toast("Workspace invite accepted.");
  } catch (error) {
    localStorage.removeItem("termyte-invite");
    toast(error.message);
  }
}

function renderWorkspacePicker() {
  $("#workspace-select").innerHTML = state.workspaces.map((workspace) =>
    `<option value="${workspace.id}" ${workspace.id === state.workspace.id ? "selected" : ""}>${escapeHtml(workspace.name)}</option>`
  ).join("");
}

async function loadWorkspace() {
  $("#sync-state").innerHTML = "<i></i>Syncing";
  content.innerHTML = '<div class="panel loading"></div>';
  try {
    const workspaceId = encodeURIComponent(state.workspace.id);
    const [threads, agents, attempts, connectors, connectorAttention] = await Promise.all([
      request(`/v1/admin/work-threads?workspace_id=${workspaceId}`),
      request(`/v1/admin/agents?workspace_id=${workspaceId}`),
      request(`/v1/admin/resolution-attempts?workspace_id=${workspaceId}`),
      request(`/v1/admin/connectors?workspace_id=${workspaceId}`),
      request(`/v1/admin/connector-attention?workspace_id=${workspaceId}`),
    ]);
    state.threads = threads.work_threads;
    state.agents = agents.agents.map((agent) => ({
      ...agent,
      active_credentials: agents.credentials.filter((credential) =>
        credential.agent_identity_id === agent.id && !credential.revoked_at
      ).length,
      active_grants: agents.grants.filter((grant) =>
        grant.agent_identity_id === agent.id && !grant.revoked_at
      ).length,
    }));
    state.attempts = attempts.attempts;
    state.connections = connectors.connections;
    state.connectorMappings = connectors.mappings;
    state.connectorLinks = connectorAttention.links;
    state.selectedThread = state.threads.find((thread) => thread.id === state.selectedThread?.id) || state.threads[0] || null;
    state.selectedDetail = null;
    const attentionCount = state.attempts.length + state.connectorLinks.length;
    $("#attention-count").hidden = !attentionCount;
    $("#attention-count").textContent = attentionCount;
    render();
    $("#sync-state").innerHTML = "<i></i>Live";
  } catch (error) {
    content.innerHTML = `<div class="panel empty"><div class="empty-mark">!</div><h2>Could not load this workspace</h2><p>${escapeHtml(error.message)}</p></div>`;
    $("#sync-state").textContent = "Disconnected";
  }
}

function setView(view) {
  state.view = view;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  const copy = {
    work: ["LIVE WORK THREADS", "Work"],
    attention: ["UNRESOLVED INTENT", "Needs attention"],
    connections: ["ORGANIZATIONAL CONTEXT", "Connections"],
    settings: ["WORKSPACE CONTROL", "Settings"],
  }[view];
  $("#page-eyebrow").textContent = copy[0];
  $("#page-title").textContent = copy[1];
  render();
}

function render() {
  if (state.view === "work") renderWork();
  if (state.view === "attention") renderAttention();
  if (state.view === "connections") renderConnections();
  if (state.view === "settings") renderSettings();
}

function renderOnboarding() {
  $("#workspace-select").innerHTML = '<option>No workspace</option>';
  content.innerHTML = `
    <div class="panel empty">
      <div class="empty-mark">T</div>
      <h2>Create your first workspace</h2>
      <p>A workspace keeps your team’s agents, work, and context separate.</p>
      <button id="create-workspace" class="primary" type="button">Create workspace</button>
    </div>`;
  $("#create-workspace").onclick = openCreateWorkspace;
}

function openCreateWorkspace() {
  setModal("NEW WORKSPACE", "Name your workspace", `
    <form id="workspace-form" class="modal-form">
      <label>Workspace name<input name="name" required maxlength="200" placeholder="Acme"></label>
      <label>URL name<input name="slug" required minlength="2" maxlength="63" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="acme"></label>
      <button class="primary" type="submit">Create workspace</button>
    </form>`);
  $("#workspace-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await request("/v1/admin/workspaces", { method: "POST", body: JSON.stringify(data) });
      modal.close();
      await enterApp();
      toast("Workspace created.");
    } catch (error) { toast(error.message); }
  };
}

function renderWork() {
  content.innerHTML = `
    <div class="view-grid">
      <section class="panel">
        <header class="panel-header">
          <h2>${state.threads.length} Work Thread${state.threads.length === 1 ? "" : "s"}</h2>
          <input id="thread-search" class="search" type="search" placeholder="Filter work">
        </header>
        <div id="thread-list" class="thread-list">${threadRows(state.threads)}</div>
      </section>
      <section id="thread-detail" class="panel detail">${state.selectedThread ? '<div class="loading"></div>' : emptyWork()}</section>
    </div>`;
  $("#thread-search").oninput = (event) => {
    const query = event.target.value.toLowerCase();
    $("#thread-list").innerHTML = threadRows(state.threads.filter((thread) =>
      `${thread.title} ${thread.objective} ${thread.current_summary || ""}`.toLowerCase().includes(query)
    ));
    bindThreadRows();
  };
  bindThreadRows();
  if (state.selectedThread) loadThreadDetail(state.selectedThread.id);
}

function threadRows(threads) {
  if (!threads.length) return emptyWork();
  return threads.map((thread) => `
    <button class="thread-row ${thread.id === state.selectedThread?.id ? "active" : ""}" data-thread="${thread.id}" type="button">
      <div class="thread-row-top"><h3>${escapeHtml(thread.title)}</h3>${status(thread.status)}</div>
      <p>${escapeHtml(thread.current_summary || thread.objective)}</p>
      <div class="meta-row"><span>${thread.event_count} events</span><span>·</span><span>${thread.receipt_count} briefings</span><span>·</span><span>${relativeTime(thread.updated_at)}</span></div>
    </button>`).join("");
}

function emptyWork() {
  return '<div class="empty"><div class="empty-mark">W</div><h2>No work yet</h2><p>Work Threads appear when a connected agent starts or continues work.</p></div>';
}

function bindThreadRows() {
  $$("[data-thread]").forEach((row) => row.onclick = () => {
    state.selectedThread = state.threads.find((thread) => thread.id === row.dataset.thread);
    state.selectedDetail = null;
    state.detailTab = "context";
    renderWork();
  });
}

async function loadThreadDetail(id) {
  try {
    state.selectedDetail = await request(`/v1/admin/work-threads/${id}?workspace_id=${encodeURIComponent(state.workspace.id)}`);
    renderThreadDetail();
  } catch (error) {
    $("#thread-detail").innerHTML = `<div class="empty"><h2>Could not load this work</h2><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderThreadDetail() {
  const detail = state.selectedDetail;
  if (!detail || detail.work_thread.id !== state.selectedThread.id) return;
  const work = detail.work_thread;
  $("#thread-detail").innerHTML = `
    <div class="detail-hero">
      <div class="thread-row-top"><div><p class="eyebrow">${escapeHtml(work.repository_key || "WORK THREAD")}</p><h2>${escapeHtml(work.title)}</h2></div>${status(work.status)}</div>
      <p>${escapeHtml(work.current_summary || work.objective)}</p>
      <div class="meta-row"><span>Version ${work.version}</span><span>·</span><span>Updated ${relativeTime(work.updated_at)}</span></div>
      <div class="detail-actions">
        <button id="preview-context" class="primary" type="button">Preview agent context</button>
        <button id="toggle-delivery" class="${work.context_delivery_enabled ? "secondary" : "danger"}" type="button">${work.context_delivery_enabled ? "Pause context" : "Resume context"}</button>
      </div>
    </div>
    <div class="tabs">
      ${tab("context", `Context (${detail.context_items.length})`)}
      ${tab("receipts", `Receipts (${detail.receipts.length})`)}
      ${tab("outcomes", `Outcomes (${detail.outcomes.length})`)}
    </div>
    <div id="detail-body" class="detail-body">${detailTab()}</div>`;
  $$(".tab").forEach((button) => button.onclick = () => {
    state.detailTab = button.dataset.tab;
    renderThreadDetail();
  });
  $("#preview-context").onclick = openPreview;
  $("#toggle-delivery").onclick = async () => {
    await request("/v1/admin/context-delivery", {
      method: "POST",
      body: JSON.stringify({ workspace_id: state.workspace.id, target: "work_thread", target_id: work.id, enabled: !work.context_delivery_enabled }),
    });
    toast(work.context_delivery_enabled ? "Context delivery paused." : "Context delivery resumed.");
    await loadThreadDetail(work.id);
  };
  bindDetailActions();
}

function tab(name, label) {
  return `<button class="tab ${state.detailTab === name ? "active" : ""}" data-tab="${name}" type="button">${label}</button>`;
}

function detailTab() {
  const detail = state.selectedDetail;
  if (state.detailTab === "context") {
    if (!detail.context_items.length) return '<div class="empty"><p>No context has been observed yet.</p></div>';
    return `<div class="section-heading"><div><h3>What agents can know</h3><p>Correct or restrict anything that should not travel.</p></div></div>
      <div class="stack">${detail.context_items.map((item) => `
        <article class="context-item">
          <div class="item-top"><span class="context-type">${escapeHtml(item.type.replaceAll("_", " "))}</span><div class="item-actions">
            <button data-edit-item="${item.id}" type="button">Edit</button>
            <button data-restrict-item="${item.id}" type="button">Restrict</button>
            <button data-outdate-item="${item.id}" type="button">Outdated</button>
          </div></div>
          <p>${escapeHtml(item.text)}</p>
          <div class="source-note">${item.source_event_ids.length} source${item.source_event_ids.length === 1 ? "" : "s"} · confidence ${Math.round(Number(item.confidence) * 100)}% · ${escapeHtml(item.state)}</div>
        </article>`).join("")}</div>
      ${detail.sources?.length ? `<div class="section-heading"><div><h3>Organizational sources</h3><p>Where this work context came from.</p></div></div>
        <div class="stack">${detail.sources.map((source) => `
          <article class="context-item">
            <div class="item-top"><span class="context-type">${escapeHtml(source.source)}</span><span class="muted">${relativeTime(source.occurred_at)}</span></div>
            <p>${escapeHtml(source.payload_text || source.event_type)}</p>
            ${source.canonical_url ? `<a href="${escapeHtml(source.canonical_url)}" target="_blank" rel="noreferrer">Open source record</a>` : ""}
          </article>`).join("")}</div>` : ""}`;
  }
  if (state.detailTab === "receipts") {
    if (!detail.receipts.length) return '<div class="empty"><p>No context has been sent to an agent yet.</p></div>';
    return `<div class="section-heading"><div><h3>Context receipts</h3><p>The exact briefing each agent received.</p></div></div>
      <div class="stack">${detail.receipts.map((receipt) => `
        <button class="receipt" data-receipt="${receipt.id}" type="button">
          <div class="receipt-top"><strong>${escapeHtml(receipt.agent_name)}</strong><span>${relativeTime(receipt.created_at)}</span></div>
          <p>“${escapeHtml(receipt.request_text)}”</p>
          <small>${receipt.item_count} context items · ${receipt.briefing_token_count} estimated tokens · v${receipt.work_thread_version}</small>
        </button>`).join("")}</div>`;
  }
  if (!detail.outcomes.length) return '<div class="empty"><p>No outcomes have been reported yet.</p></div>';
  return `<div class="section-heading"><div><h3>Agent outcomes</h3><p>Claims need evidence or human confirmation.</p></div></div>
    <div class="stack">${detail.outcomes.map((outcome) => `
      <article class="outcome">
        <div class="receipt-top"><strong>${escapeHtml(outcome.agent_name)}</strong>${status(outcome.status)}</div>
        <p>${escapeHtml(outcome.summary)}</p>
        <small>${outcomeEvidence(outcome)} · ${relativeTime(outcome.reported_at)}</small>
        ${detail.work_thread.status === "in_review" && outcome.status === "succeeded" ? `<div class="detail-actions"><button class="secondary" data-confirm-outcome="${outcome.id}" type="button">Confirm outcome</button></div>` : ""}
      </article>`).join("")}</div>`;
}

function outcomeEvidence(outcome) {
  const evidence = outcome.evidence_json;
  if (!evidence || (Array.isArray(evidence) && !evidence.length)) return "agent report";
  const text = JSON.stringify(evidence).toLowerCase();
  if (text.includes("test")) return "test evidence";
  if (text.includes("build")) return "build evidence";
  if (text.includes("diff")) return "code change evidence";
  return "reported evidence";
}

function bindDetailActions() {
  $$("[data-receipt]").forEach((button) => button.onclick = () => openReceipt(button.dataset.receipt));
  $$("[data-edit-item]").forEach((button) => button.onclick = () => openEditItem(button.dataset.editItem));
  $$("[data-restrict-item]").forEach((button) => button.onclick = () => openRestrictItem(button.dataset.restrictItem));
  $$("[data-outdate-item]").forEach((button) => button.onclick = () => correctItem(button.dataset.outdateItem, "outdated"));
  $$("[data-confirm-outcome]").forEach((button) => button.onclick = async () => {
    await request(`/v1/admin/outcomes/${button.dataset.confirmOutcome}/confirm`, {
      method: "POST", body: JSON.stringify({ workspace_id: state.workspace.id }),
    });
    toast("Outcome confirmed.");
    await loadThreadDetail(state.selectedThread.id);
  });
}

async function openReceipt(id) {
  try {
    const data = await request(`/v1/admin/receipts/${id}?workspace_id=${encodeURIComponent(state.workspace.id)}`);
    setModal("CONTEXT RECEIPT", `What ${data.receipt.agent_name} received`, `
      <div class="callout">Prompt: “${escapeHtml(data.receipt.request_text)}” · ${data.receipt.briefing_token_count} estimated tokens</div>
      <pre class="briefing">${escapeHtml(data.receipt.briefing_text)}</pre>
      <h3>Why each item was included</h3>
      <div>${data.items.map((item) => `
        <div class="receipt-item"><span class="context-type">${escapeHtml(item.type)}</span><p>${escapeHtml(item.source_snapshot_json?.text || item.current_text || "")}</p><small>${escapeHtml(item.inclusion_reason)}</small></div>`).join("")}</div>`);
  } catch (error) { toast(error.message); }
}

function openEditItem(id) {
  const item = state.selectedDetail.context_items.find((candidate) => candidate.id === id);
  setModal("HUMAN CONTROL", "Correct this context", `
    <form id="edit-item-form" class="modal-form">
      <label>Correct text<textarea name="text" required maxlength="100000">${escapeHtml(item.text)}</textarea></label>
      <div class="button-row"><button class="primary" type="submit">Save correction</button><button id="mark-incorrect" class="danger" type="button">Mark incorrect</button></div>
    </form>`);
  $("#edit-item-form").onsubmit = async (event) => {
    event.preventDefault();
    await correctItem(id, "edit", new FormData(event.currentTarget).get("text"));
    modal.close();
  };
  $("#mark-incorrect").onclick = async () => { await correctItem(id, "incorrect"); modal.close(); };
}

function openRestrictItem(id) {
  const item = state.selectedDetail.context_items.find((candidate) => candidate.id === id);
  setModal("PERMISSIONS", "Choose which agents can receive this", `
    <form id="restrict-form" class="modal-form">
      <p class="muted">With no agents selected, this context is available to every agent that has access to the Work Thread.</p>
      ${state.agents.map((agent) => `<label><span><input type="checkbox" name="agent" value="${agent.id}" ${item.restricted_to_agent_identity_ids.includes(agent.id) ? "checked" : ""}> ${escapeHtml(agent.name)}</span></label>`).join("")}
      <button class="primary" type="submit">Save restriction</button>
    </form>`);
  $("#restrict-form").onsubmit = async (event) => {
    event.preventDefault();
    const ids = new FormData(event.currentTarget).getAll("agent");
    await request(`/v1/admin/work-threads/${state.selectedThread.id}/context-items/${id}/restrict`, {
      method: "POST", body: JSON.stringify({ workspace_id: state.workspace.id, agent_identity_ids: ids }),
    });
    modal.close();
    toast("Context restriction saved.");
    await loadThreadDetail(state.selectedThread.id);
  };
}

async function correctItem(id, action, text) {
  try {
    await request(`/v1/admin/work-threads/${state.selectedThread.id}/context-items/${id}/correct`, {
      method: "POST", body: JSON.stringify({ workspace_id: state.workspace.id, action, ...(text ? { text } : {}) }),
    });
    toast(action === "edit" ? "Context corrected." : `Context marked ${action}.`);
    await loadThreadDetail(state.selectedThread.id);
  } catch (error) { toast(error.message); }
}

function openPreview() {
  if (!state.agents.length) return toast("Create an Agent Identity first.");
  setModal("DELIVERY PREVIEW", "See what an agent would receive", `
    <form id="preview-form" class="modal-form">
      <label>Agent<select name="agent">${state.agents.map((agent) => `<option value="${agent.id}">${escapeHtml(agent.name)} · ${escapeHtml(agent.kind)}</option>`).join("")}</select></label>
      <button class="primary" type="submit">Build preview</button>
      <div id="preview-result"></div>
    </form>`);
  $("#preview-form").onsubmit = async (event) => {
    event.preventDefault();
    const agent = new FormData(event.currentTarget).get("agent");
    try {
      const result = await request(`/v1/admin/work-threads/${state.selectedThread.id}/preview`, {
        method: "POST", body: JSON.stringify({ workspace_id: state.workspace.id, agent_identity_id: agent, token_budget: 2000 }),
      });
      $("#preview-result").innerHTML = result.deliverable
        ? `<div class="callout">Deliverable · ${result.estimated_tokens} estimated tokens · ${result.sources.length} sources</div><pre class="briefing">${escapeHtml(result.briefing)}</pre>`
        : `<div class="callout error">${escapeHtml(result.blocked_reason)}</div>`;
    } catch (error) { toast(error.message); }
  };
}

function renderAttention() {
  const hasAttention = state.attempts.length || state.connectorLinks.length;
  content.innerHTML = hasAttention ? `
    <section class="panel">
      <header class="panel-header"><div><h2>Review uncertain context</h2><p class="muted">Termyte abstains when a link or instruction is not reliable enough.</p></div></header>
      <div class="detail-body stack">${state.connectorLinks.map((link) => `
        <article class="attention-card">
          <div class="receipt-top">${status(link.cross_repository ? "cross_repository" : "proposed")}<span class="muted">${relativeTime(link.created_at)}</span></div>
          <h3>${escapeHtml(link.work_thread_title)}</h3>
          <p>${escapeHtml(link.payload_text || "Organizational source")}</p>
          <p class="muted">${escapeHtml(link.provider)} · ${Math.round(link.confidence * 100)}% confidence · ${escapeHtml(link.reason)}</p>
          <div class="button-row"><button class="primary" data-source-link="${link.id}" data-accept="true" type="button">Link context</button><button class="secondary" data-source-link="${link.id}" data-accept="false" type="button">Reject</button></div>
        </article>`).join("")}${state.attempts.map((attempt) => `
        <article class="attention-card">
          <div class="receipt-top">${status(attempt.state)}<span class="muted">${relativeTime(attempt.created_at)}</span></div>
          <h3>“${escapeHtml(attempt.request_text)}”</h3>
          <p class="muted">${escapeHtml(attempt.agent_name)} · ${escapeHtml(attempt.agent_kind)}</p>
          <button class="secondary" data-resolve-attempt="${attempt.id}" type="button">Mark reviewed</button>
        </article>`).join("")}</div>
    </section>` : '<div class="panel empty"><div class="empty-mark">✓</div><h2>Nothing needs attention</h2><p>Recent context links and agent instructions are resolved.</p></div>';
  $$("[data-source-link]").forEach((button) => button.onclick = async () => {
    await request(`/v1/admin/source-links/${button.dataset.sourceLink}/decide`, {
      method: "POST",
      body: JSON.stringify({
        workspace_id: state.workspace.id,
        accept: button.dataset.accept === "true",
      }),
    });
    toast(button.dataset.accept === "true" ? "Context linked." : "Link rejected.");
    await loadWorkspace();
  });
  $$("[data-resolve-attempt]").forEach((button) => button.onclick = async () => {
    await request(`/v1/admin/resolution-attempts/${button.dataset.resolveAttempt}/resolve`, {
      method: "POST", body: JSON.stringify({ workspace_id: state.workspace.id }),
    });
    toast("Marked reviewed.");
    await loadWorkspace();
  });
}

function renderConnections() {
  content.innerHTML = `
    <div class="panel">
      <header class="panel-header"><div><h2>Coding agents</h2><p class="muted">Connect Codex and Claude Code from the Termyte CLI.</p></div></header>
      <div class="detail-body">${state.agents.length ? `<div class="agent-grid">${state.agents.map((agent) => `
        <article class="agent-card">
          <header><div><h3>${escapeHtml(agent.name)}</h3><p>${escapeHtml(agent.kind)}</p></div>${status(agent.status)}</header>
          <p>${agent.active_credentials} active credential${agent.active_credentials === 1 ? "" : "s"} · ${agent.active_grants} Work Thread grant${agent.active_grants === 1 ? "" : "s"}</p>
          <div class="button-row">
            <button class="secondary" data-credential="${agent.id}" type="button">Create credential</button>
            <button class="${agent.status === "active" ? "danger" : "secondary"}" data-agent-status="${agent.id}" data-status="${agent.status === "active" ? "disabled" : "active"}" type="button">${agent.status === "active" ? "Disable" : "Enable"}</button>
          </div>
        </article>`).join("")}</div>` : '<div class="empty"><p>No agents connected yet.</p></div>'}</div>
    </div>
    <div class="panel">
      <header class="panel-header"><div><h2>Organizational source</h2><p class="muted">Bring company intent into coding-agent work from Slack.</p></div></header>
      <div class="detail-body">
        <div class="agent-grid">${["slack"].map((provider) => {
          const connection = state.connections.find((item) =>
            item.provider === provider && item.status !== "revoked"
          );
          const mappings = connection ? state.connectorMappings.filter((item) =>
            item.connector_connection_id === connection.id
          ) : [];
          return `<article class="agent-card">
            <header><div><h3>${provider[0].toUpperCase() + provider.slice(1)}</h3><p>${connection ? escapeHtml(connection.name) : "Not connected"}</p></div>${connection ? status(connection.status) : status("inactive")}</header>
            <p>${connection ? `${mappings.length} mapped scope${mappings.length === 1 ? "" : "s"}${connection.last_synced_at ? ` · synced ${relativeTime(connection.last_synced_at)}` : ""}` : "Connect a read-only organizational source."}</p>
            <div class="button-row">${connection
              ? `<button class="secondary" data-map-connector="${connection.id}" type="button">Map scope</button><button class="danger" data-revoke-connector="${connection.id}" type="button">Revoke</button>`
              : `<button class="primary" data-connect-provider="${provider}" type="button">Connect ${provider}</button>`}</div>
          </article>`;
        }).join("")}</div>
      </div>
    </div>`;
  $$("[data-agent-status]").forEach((button) => button.onclick = async () => {
    await request(`/v1/admin/agents/${button.dataset.agentStatus}/status`, {
      method: "POST", body: JSON.stringify({ workspace_id: state.workspace.id, status: button.dataset.status }),
    });
    toast(`Agent ${button.dataset.status}.`);
    await loadWorkspace();
  });
  $$("[data-credential]").forEach((button) => button.onclick = () => createCredential(button.dataset.credential));
  $$("[data-connect-provider]").forEach((button) => button.onclick = () =>
    connectProvider(button.dataset.connectProvider));
  $$("[data-map-connector]").forEach((button) => button.onclick = () =>
    openScopeMapping(button.dataset.mapConnector));
  $$("[data-revoke-connector]").forEach((button) => button.onclick = async () => {
    await request(`/v1/admin/connectors/${button.dataset.revokeConnector}/revoke`, {
      method: "POST", body: JSON.stringify({ workspace_id: state.workspace.id }),
    });
    toast("Connection revoked. Retained context remains available.");
    await loadWorkspace();
  });
}

function openNewAgent() {
  setModal("NEW IDENTITY", "Add an agent", `
    <form id="agent-form" class="modal-form">
      <label>Name<input name="name" required maxlength="500" placeholder="Engineering Codex"></label>
      <label>Agent type<select name="kind"><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select></label>
      <button class="primary" type="submit">Create Agent Identity</button>
    </form>`);
  $("#agent-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    await request("/v1/admin/agents", {
      method: "POST", body: JSON.stringify({ workspace_id: state.workspace.id, ...data }),
    });
    modal.close();
    toast("Agent Identity created.");
    await loadWorkspace();
  };
}

async function connectProvider(provider) {
  try {
    const result = await request(`/v1/admin/connectors/${provider}/start`, {
      method: "POST",
      body: JSON.stringify({ workspace_id: state.workspace.id, selected_scopes: [] }),
    });
    location.href = result.authorization_url;
  } catch (error) { toast(error.message); }
}

function openScopeMapping(connectorId) {
  setModal("CONTEXT SCOPE", "Map a source to a repository", `
    <form id="scope-form" class="modal-form">
      <p class="muted">Map an approved channel, team, project, or repository to the code it describes.</p>
      <label>Source ID<input name="external_scope_id" required maxlength="500" placeholder="C0123 or team-id"></label>
      <label>Source name<input name="external_scope_name" required maxlength="500" placeholder="#customer-bugs"></label>
      <label>Repository<input name="repository_key" required maxlength="500" placeholder="github.com/acme/demo-auth"></label>
      <button class="primary" type="submit">Save mapping</button>
    </form>`);
  $("#scope-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    await request(`/v1/admin/connectors/${connectorId}/scopes`, {
      method: "POST",
      body: JSON.stringify({ workspace_id: state.workspace.id, ...data }),
    });
    modal.close();
    toast("Source mapped to repository.");
    await loadWorkspace();
  };
}

async function createCredential(agentIdentityId) {
  try {
    const credential = await request("/v1/admin/credentials", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: state.workspace.id,
        agent_identity_id: agentIdentityId,
        scopes: ["events:write", "context:read", "outcomes:write", "handoffs:create", "handoffs:claim"],
      }),
    });
    setModal("ONE-TIME SECRET", "Copy this credential now", `
      <div class="callout error">This secret is shown once. Store it in the agent, not in source control.</div>
      <pre class="briefing">${escapeHtml(credential.token)}</pre>
      <button id="copy-token" class="primary" type="button">Copy credential</button>`);
    $("#copy-token").onclick = async () => {
      await navigator.clipboard.writeText(credential.token);
      toast("Credential copied.");
    };
  } catch (error) { toast(error.message); }
}

function openDeviceApproval() {
  const userCode = new URLSearchParams(location.search).get("code")?.toUpperCase();
  if (!userCode) {
    setModal("CONNECT CODING AGENT", "Missing device code", `
      <div class="callout error">Start the connection from the Termyte CLI, then open the link it prints.</div>`);
    return;
  }
  setModal("CONNECT CODING AGENT", "Approve this device", `
    <form id="device-form" class="modal-form">
      <div class="callout">Code: ${escapeHtml(userCode)}</div>
      <label>Workspace<select name="workspace_id">${state.workspaces.map((workspace) =>
        `<option value="${workspace.id}" ${workspace.id === state.workspace.id ? "selected" : ""}>${escapeHtml(workspace.name)}</option>`
      ).join("")}</select></label>
      <label>Device name<input name="agent_name" required maxlength="500" value="My coding agent"></label>
      <button class="primary" type="submit">Approve device</button>
    </form>`);
  $("#device-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await request("/v1/admin/device/approve", {
        method: "POST",
        body: JSON.stringify({ user_code: userCode, ...data }),
      });
      $("#modal-body").innerHTML = `
        <div class="empty"><div class="empty-mark">✓</div><h2>Device connected</h2>
        <p>You can return to the coding agent.</p></div>`;
      history.replaceState({}, "", "/");
      await loadWorkspace();
    } catch (error) {
      toast(error.message);
    }
  };
}

async function renderSettings() {
  content.innerHTML = '<div class="panel loading"></div>';
  try {
    const usage = await request(`/v1/admin/usage?workspace_id=${encodeURIComponent(state.workspace.id)}`);
    const item = usage.usage;
    content.innerHTML = `
      <div class="cards">
        ${metric("Source events this month", item.source_events.toLocaleString(), "of 250,000 fair use")}
        ${metric("Context briefings", item.context_briefings.toLocaleString(), "of 25,000 fair use")}
        ${metric("Active agents", item.agent_identities.toLocaleString(), "of 100 fair use")}
      </div>
      <div class="settings-grid wide-panel">
        <section class="panel">
          <div class="settings-section"><p class="eyebrow">WORKSPACE</p><h2>${escapeHtml(state.workspace.name)}</h2><p>${escapeHtml(state.workspace.slug)} · ${escapeHtml(state.workspace.role)} · ${escapeHtml(state.workspace.subscription_state)}</p></div>
          <div class="settings-section"><h3>Data retention</h3><p>Raw source payloads are removed after this period. Derived work context remains.</p><div class="button-row"><select id="retention" aria-label="Retention period"><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">1 year</option></select><button id="save-retention" class="secondary" type="button">Save</button></div></div>
          <div class="settings-section"><h3>Workspace data</h3><p>Download a JSON export of your workspace, permissions, context, and audit records.</p><button id="export-workspace" class="secondary" type="button">Export data</button></div>
        </section>
        <section class="panel">
          <div class="settings-section"><p class="eyebrow">DEMO</p><h2>Intent delivery</h2><p>Termyte automatically briefs connected coding agents when work begins.</p></div>
          <div class="settings-section danger-zone"><p class="eyebrow">CONTEXT DELIVERY</p><h3>${state.workspace.context_delivery_enabled === false ? "Paused" : "Enabled"}</h3><p>Pause every context delivery from this workspace without disconnecting agents.</p><button id="workspace-delivery" class="${state.workspace.context_delivery_enabled === false ? "secondary" : "danger"}" type="button">${state.workspace.context_delivery_enabled === false ? "Resume delivery" : "Pause delivery"}</button></div>
        </section>
      </div>`;
    $("#retention").value = String(state.workspace.retention_days);
    $("#save-retention").onclick = async () => {
      await request(`/v1/admin/workspaces/${state.workspace.id}/retention`, {
        method: "POST", body: JSON.stringify({ retention_days: Number($("#retention").value) }),
      });
      toast("Retention updated.");
    };
    $("#export-workspace").onclick = () => downloadExport();
    $("#workspace-delivery").onclick = async () => {
      const enabled = state.workspace.context_delivery_enabled === false;
      await request("/v1/admin/context-delivery", {
        method: "POST", body: JSON.stringify({ workspace_id: state.workspace.id, target: "workspace", target_id: state.workspace.id, enabled }),
      });
      state.workspace.context_delivery_enabled = enabled;
      toast(enabled ? "Context delivery resumed." : "All context delivery paused.");
      renderSettings();
    };
  } catch (error) {
    content.innerHTML = `<div class="panel empty"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function metric(label, value, note) {
  return `<article class="panel metric"><span>${label}</span><strong>${value}</strong><small class="muted">${note}</small></article>`;
}

async function downloadExport() {
  try {
    const response = await fetch(`/v1/admin/workspaces/${state.workspace.id}/export`, {
      headers: { authorization: `Bearer ${state.session.access_token}` },
    });
    if (!response.ok) throw new Error("Export failed");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = `termyte-${state.workspace.slug}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) { toast(error.message); }
}

async function openBilling() {
  try {
    const endpoint = state.workspace.subscription_state === "active" ? "portal" : "checkout";
    const result = await request(`/v1/admin/billing/${endpoint}`, {
      method: "POST", body: JSON.stringify({ workspace_id: state.workspace.id }),
    });
    location.href = result.url;
  } catch (error) { toast(error.message); }
}

$("#auth-form").onsubmit = async (event) => {
  event.preventDefault();
  const endpoint = state.signUp ? "signup" : "token?grant_type=password";
  const response = await fetch(`${state.config.supabase_url}/auth/v1/${endpoint}`, {
    method: "POST",
    headers: { apikey: state.config.supabase_anon_key, "content-type": "application/json" },
    body: JSON.stringify({ email: $("#email").value, password: $("#password").value }),
  });
  const result = await response.json();
  if (!response.ok) return $("#auth-note").textContent = result.msg || result.error_description || "Could not sign in.";
  if (!result.access_token) {
    $("#auth-note").style.color = "var(--green)";
    $("#auth-note").textContent = "Check your email to confirm your account, then sign in.";
    return;
  }
  saveSession(result);
  await enterApp();
};

$("#auth-mode").onclick = () => {
  state.signUp = !state.signUp;
  $("#auth-mode").textContent = state.signUp ? "Sign in instead" : "Create an account instead";
  $(".auth-card h2").textContent = state.signUp ? "Create your account" : "Sign in to Termyte";
  $("#auth-note").textContent = "";
};
$("#sign-out").onclick = signOut;
$("#modal-close").onclick = () => modal.close();
$("#refresh").onclick = loadWorkspace;
$("#workspace-select").onchange = async (event) => {
  state.workspace = state.workspaces.find((workspace) => workspace.id === event.target.value);
  localStorage.setItem("termyte-workspace", state.workspace.id);
  await loadWorkspace();
};
$$(".nav-item").forEach((item) => item.onclick = () => setView(item.dataset.view));

initialize().catch((error) => {
  $("#auth-note").textContent = error.message;
});
