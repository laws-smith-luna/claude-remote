/**
 * Sessions UI — session list cards with status badges.
 * Multi-origin: fetches from all configured machines and merges client-side.
 */

import { cacheSessions, getCachedSessions } from "./offline-store.js";

const sessionListEl = document.getElementById("session-list");
const sessionCountEl = document.getElementById("session-count");
const usageBarEl = document.getElementById("usage-bar");
const refreshBtn = document.getElementById("refresh-btn");
const fabBtn = document.getElementById("new-session-fab");
const projectModal = document.getElementById("project-modal");
const projectList = document.getElementById("project-list");
const projectModalClose = document.getElementById("project-modal-close");
const offlineBanner = document.getElementById("offline-banner");

const renameModal = document.getElementById("rename-modal");
const renameInput = document.getElementById("rename-input");
const renameSaveBtn = document.getElementById("rename-save");
const renameCancelBtn = document.getElementById("rename-cancel");
const renameBackdrop = renameModal ? renameModal.querySelector(".rename-backdrop") : null;

let machines = [];  // Array of { name, url, token }
let multiWs = null;
let onSessionSelect = null;
let onNewSession = null;
let refreshInterval = null;

/** Session currently being renamed */
let renamingSessionId = null;

/** Session data stored in JS memory — avoids JSON-in-HTML-attribute issues */
let sessionDataMap = new Map();

/** Whether sessions come from multiple machines */
let multiMachine = false;

/** Map device type to icon */
function deviceIcon(type) {
  if (type === "phone") return "\u{1F4F1}";
  if (type === "tablet") return "\u{1F4F1}";
  return "\u{1F5A5}";
}

/** Per-machine badge colors (text color, bg is 15% opacity version) */
const machineColors = {
  "lightning":     { color: "#6495ed", bg: "rgba(100, 149, 237, 0.15)" },
  "work computer": { color: "#a78bfa", bg: "rgba(167, 139, 250, 0.15)" },
  "iphone mini":   { color: "#4dd0e1", bg: "rgba(77, 208, 225, 0.15)" },
  "ipad":          { color: "#f472b6", bg: "rgba(244, 114, 182, 0.15)" },
};
const defaultMachineColor = { color: "#6495ed", bg: "rgba(100, 149, 237, 0.15)" };

function machineColorStyle(name) {
  const c = machineColors[(name || "").toLowerCase()] || defaultMachineColor;
  return `color:${c.color};background:${c.bg}`;
}

/** Track which project groups are expanded */
let expandedProjects = new Set();

/** Initialize sessions UI */
export function initSessionsUI(_machines, _multiWs, _onSessionSelect, _onNewSession) {
  machines = _machines;
  multiWs = _multiWs;
  onSessionSelect = _onSessionSelect;
  onNewSession = _onNewSession;

  fabBtn.addEventListener("click", showProjectPicker);
  refreshBtn.addEventListener("click", () => {
    refreshBtn.style.transform = "rotate(360deg)";
    refreshBtn.style.transition = "transform 0.5s";
    setTimeout(() => { refreshBtn.style.transform = ""; refreshBtn.style.transition = ""; }, 500);
    refreshSessions();
  });
  projectModalClose.addEventListener("click", hideProjectPicker);

  // Close modal on backdrop click
  projectModal.querySelector(".modal-backdrop").addEventListener("click", hideProjectPicker);

  // Rename modal handlers
  if (renameSaveBtn) renameSaveBtn.addEventListener("click", saveRename);
  if (renameCancelBtn) renameCancelBtn.addEventListener("click", hideRenameModal);
  if (renameBackdrop) renameBackdrop.addEventListener("click", hideRenameModal);
  if (renameInput) renameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveRename();
    if (e.key === "Escape") hideRenameModal();
  });
}

/** Start auto-refresh of session list */
export function startRefresh() {
  refreshSessions();
  clearInterval(refreshInterval);
  refreshInterval = setInterval(refreshSessions, 15000);
}

/** Stop auto-refresh */
export function stopRefresh() {
  clearInterval(refreshInterval);
}

/** Fetch and render discovered sessions from all machines */
export async function refreshSessions() {
  // Fetch usage in parallel (from first machine — usage is account-level)
  refreshUsageBar();

  // Fetch from all machines in parallel
  const fetches = machines.map(async (machine) => {
    const res = await fetch(`${machine.url}/api/discover`, {
      headers: { Authorization: `Bearer ${machine.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sessions = await res.json();
    // Tag each session with machine info for routing
    return sessions.map((s) => ({
      ...s,
      machineName: s.machineName || machine.name,
      _machineType: s.machineType || machine.type || "desktop",
      _machineUrl: machine.url,
      _machineToken: machine.token,
    }));
  });

  const results = await Promise.allSettled(fetches);

  // Merge successful results
  let allSessions = [];
  let anySucceeded = false;
  for (const result of results) {
    if (result.status === "fulfilled") {
      allSessions.push(...result.value);
      anySucceeded = true;
    }
  }

  if (anySucceeded) {
    // Sort by most recent first
    allSessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    renderSessionList(allSessions);

    // Cache for offline use
    cacheSessions(allSessions);

    // Hide offline banner
    if (offlineBanner) offlineBanner.classList.add("hidden");
  } else {
    // All machines failed — try cached sessions
    try {
      const cached = await getCachedSessions();
      if (cached && cached.length > 0) {
        renderSessionList(cached);
        if (offlineBanner) offlineBanner.classList.remove("hidden");
      } else {
        sessionListEl.innerHTML = `<p class="sessions-empty">All machines offline</p>`;
      }
    } catch {
      sessionListEl.innerHTML = `<p class="sessions-empty">All machines offline</p>`;
    }
  }
}

/** Fetch usage data and render the bar */
async function refreshUsageBar() {
  if (!machines.length) return;
  const machine = machines[0];
  try {
    const res = await fetch(`${machine.url}/api/usage`, {
      headers: { Authorization: `Bearer ${machine.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderUsageBar(data);
  } catch {
    // Hide bar on error — non-critical
    if (usageBarEl) usageBarEl.classList.add("hidden");
  }
}

/** Render usage bar from API data */
function renderUsageBar(data) {
  if (!usageBarEl) return;
  const fh = data.five_hour || {};
  const sd = data.seven_day || {};

  const fhPct = Math.round(fh.utilization || 0);
  const sdPct = Math.round(sd.utilization || 0);
  const fhReset = fh.resets_at ? formatResetTime(fh.resets_at) : "";
  const sdReset = sd.resets_at ? formatResetTime(sd.resets_at) : "";

  // Calculate pacing marker for 5h window: "where you should be" if consuming evenly
  let paceMarkerHtml = "";
  if (fh.resets_at) {
    const resetTime = new Date(fh.resets_at).getTime();
    const windowStart = resetTime - 5 * 3600 * 1000;
    const elapsed = Date.now() - windowStart;
    const pacePct = Math.max(0, Math.min(100, (elapsed / (5 * 3600000)) * 100));
    paceMarkerHtml = `<div class="usage-pace-marker" style="left:${pacePct}%"></div>`;
  }

  usageBarEl.innerHTML = `
    <div class="usage-bar-col">
      <div class="usage-bar-label">
        <span>5h: <span class="usage-bar-pct">${fhPct}%</span></span>
        ${fhReset ? `<span class="usage-bar-reset">${esc(fhReset)}</span>` : ""}
      </div>
      <div class="usage-bar-track">
        <div class="usage-bar-fill ${usageColorClass(fhPct)}" style="width:${fhPct}%"></div>
        ${paceMarkerHtml}
      </div>
    </div>
    <div class="usage-bar-sep"></div>
    <div class="usage-bar-col">
      <div class="usage-bar-label">
        <span>7d: <span class="usage-bar-pct">${sdPct}%</span></span>
        ${sdReset ? `<span class="usage-bar-reset">${esc(sdReset)}</span>` : ""}
      </div>
      <div class="usage-bar-track">
        <div class="usage-bar-fill ${usageColorClass(sdPct)}" style="width:${sdPct}%"></div>
      </div>
    </div>
  `;
  usageBarEl.classList.remove("hidden");
}

/** Color class based on utilization percentage */
function usageColorClass(pct) {
  if (pct >= 80) return "usage-red";
  if (pct >= 50) return "usage-amber";
  return "usage-green";
}

/** Format reset time as local short time (e.g. "3:59pm") */
function formatResetTime(isoStr) {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  } catch {
    return "";
  }
}

/** Render the session card list, grouped by project */
function renderSessionList(sessions) {
  // Store session data in JS Map instead of HTML attributes
  sessionDataMap = new Map();
  for (const s of sessions) {
    sessionDataMap.set(s.sessionId, s);
  }

  // Detect if sessions come from multiple machines
  const machineNames = new Set(sessions.map((s) => s.machineName).filter(Boolean));
  multiMachine = machineNames.size > 1;

  if (sessions.length === 0) {
    sessionListEl.innerHTML = `
      <div class="sessions-empty">
        <p>No active sessions</p>
        <p class="sessions-empty-hint">Start a new session or open Claude Code in a terminal</p>
      </div>
    `;
    sessionCountEl.textContent = "";
    return;
  }

  sessionCountEl.textContent = sessions.length;

  // Group sessions by projectName
  const groups = new Map();
  for (const s of sessions) {
    const key = s.projectName || "Unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  // Sort groups by most recent session timestamp (descending)
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const aMax = Math.max(...a[1].map((s) => s.lastTimestamp));
    const bMax = Math.max(...b[1].map((s) => s.lastTimestamp));
    return bMax - aMax;
  });

  // Within each group, sort sessions by timestamp descending
  for (const [, groupSessions] of sortedGroups) {
    groupSessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }

  let html = "";
  for (const [projectName, groupSessions] of sortedGroups) {
    const isExpanded = expandedProjects.has(projectName);
    const isSingle = groupSessions.length === 1;
    const best = groupSessions[0]; // most recent
    const bestStatus = getBestStatus(groupSessions);
    const timeAgo = formatTimeAgo(best.lastTimestamp);

    if (isSingle) {
      // Single session — render directly as a clickable card
      const s = groupSessions[0];
      const statusClass = `status-${s.status}`;
      const borderClass = `border-${s.status}`;
      const truncAction = (s.lastAction || "").length > 65 ? s.lastAction.slice(0, 62) + "..." : (s.lastAction || "");

      const machBadge = multiMachine && s.machineName ? `<span class="machine-badge" style="${machineColorStyle(s.machineName)}">${deviceIcon(s._machineType)} ${esc(s.machineName)}</span>` : "";
      const displayTopic = s.customName || s.topic || s.slug;

      html += `
        <div class="swipe-wrapper">
          <div class="swipe-action"><span class="swipe-action-icon">&#10005;</span><span>Delete</span></div>
          <div class="session-card ${borderClass}" data-session-id="${esc(s.sessionId)}">
            <div class="session-card-top">
              <span class="session-card-name">${esc(projectName)}</span>
              <span class="session-card-badges">${machBadge}<button class="session-rename-btn" data-rename-id="${esc(s.sessionId)}">&#9998;</button><span class="status-badge ${statusClass}">${esc(s.status)}</span></span>
            </div>
            <div class="session-card-topic">${esc(displayTopic)}</div>
            <div class="session-card-meta">
              <span>${esc(s.branch)}</span>
              <span>${esc(timeAgo)}</span>
            </div>
          </div>
        </div>
      `;
    } else {
      // Multi-session project group
      const statusClass = `status-${bestStatus}`;
      const borderClass = `border-${bestStatus}`;
      const chevronClass = isExpanded ? "chevron-open" : "";

      html += `
        <div class="project-group">
          <div class="project-group-header ${borderClass}" data-project="${esc(projectName)}">
            <div class="session-card-top">
              <span class="session-card-name">${esc(projectName)}</span>
              <span class="project-group-right">
                <span class="project-group-count">${groupSessions.length}</span>
                <span class="status-badge ${statusClass}">${esc(bestStatus)}</span>
                <span class="project-group-chevron ${chevronClass}">&#9662;</span>
              </span>
            </div>
            <div class="session-card-meta">
              <span>${esc(best.branch)}</span>
              <span>${esc(timeAgo)}</span>
            </div>
          </div>
          <div class="project-group-sessions ${isExpanded ? "" : "hidden"}">
            ${groupSessions.map((s) => {
              const sStatusClass = `status-${s.status}`;
              const sBorderClass = `border-${s.status}`;
              const sTimeAgo = formatTimeAgo(s.lastTimestamp);
              const sTruncAction = (s.lastAction || "").length > 55 ? s.lastAction.slice(0, 52) + "..." : (s.lastAction || "");
              const sMachBadge = multiMachine && s.machineName ? `<span class="machine-badge" style="${machineColorStyle(s.machineName)}">${deviceIcon(s._machineType)} ${esc(s.machineName)}</span>` : "";
              const sDisplayTopic = s.customName || s.topic || s.slug;
              return `
                <div class="swipe-wrapper">
                  <div class="swipe-action"><span class="swipe-action-icon">&#10005;</span><span>Delete</span></div>
                  <div class="session-card grouped ${sBorderClass}" data-session-id="${esc(s.sessionId)}">
                    <div class="session-card-top">
                      <span class="session-card-name">${esc(sDisplayTopic)}</span>
                      <span class="session-card-badges">${sMachBadge}<button class="session-rename-btn" data-rename-id="${esc(s.sessionId)}">&#9998;</button><span class="status-badge ${sStatusClass}">${esc(s.status)}</span></span>
                    </div>
                    <div class="session-card-meta">
                      <span>${esc(sTimeAgo)}</span>
                    </div>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `;
    }
  }

  sessionListEl.innerHTML = html;

  // Attach click + swipe handlers for individual session cards
  sessionListEl.querySelectorAll(".session-card[data-session-id]").forEach((card) => {
    attachSwipeToDismiss(card);
  });

  // Attach rename pencil button handlers (stop propagation so card click doesn't fire)
  sessionListEl.querySelectorAll(".session-rename-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      showRenameModal(btn.dataset.renameId);
    });
    // Also stop touchend from triggering swipe
    btn.addEventListener("touchend", (e) => e.stopPropagation());
  });

  // Attach click handlers for project group headers (expand/collapse)
  sessionListEl.querySelectorAll(".project-group-header").forEach((header) => {
    header.addEventListener("click", () => {
      const projectName = header.dataset.project;
      const sessionsContainer = header.nextElementSibling;
      const chevron = header.querySelector(".project-group-chevron");

      if (expandedProjects.has(projectName)) {
        expandedProjects.delete(projectName);
        sessionsContainer.classList.add("hidden");
        if (chevron) chevron.classList.remove("chevron-open");
      } else {
        expandedProjects.add(projectName);
        sessionsContainer.classList.remove("hidden");
        if (chevron) chevron.classList.add("chevron-open");
      }
    });
  });

  // Render dismissed sessions section at the bottom
  renderDismissedSection();
}

/** Get the "best" status from a group (running > waiting > idle) */
function getBestStatus(sessions) {
  const priority = { running: 3, waiting: 2, idle: 1 };
  let best = "idle";
  let bestPriority = 0;
  for (const s of sessions) {
    const p = priority[s.status] || 0;
    if (p > bestPriority) {
      bestPriority = p;
      best = s.status;
    }
  }
  return best;
}

/** Show the project picker modal — fetches from all machines */
async function showProjectPicker() {
  projectModal.classList.remove("hidden");

  const fetches = machines.map(async (machine) => {
    const res = await fetch(`${machine.url}/api/projects`, {
      headers: { Authorization: `Bearer ${machine.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const projects = await res.json();
    return projects.map((p) => ({
      ...p,
      machineName: p.machineName || machine.name,
      _machineType: p.machineType || machine.type || "desktop",
      _machineUrl: machine.url,
      _machineToken: machine.token,
    }));
  });

  try {
    const results = await Promise.allSettled(fetches);
    let allProjects = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        allProjects.push(...result.value);
      }
    }

    // Deduplicate by path + machineName
    const seen = new Set();
    allProjects = allProjects.filter((p) => {
      const key = `${p.machineName}:${p.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    renderProjectList(allProjects);
  } catch (err) {
    projectList.innerHTML = `<p class="sessions-empty">Error: ${esc(err.message)}</p>`;
  }
}

/** Hide the project picker modal */
function hideProjectPicker() {
  projectModal.classList.add("hidden");
}

/** Show rename modal for a session */
function showRenameModal(sessionId) {
  const session = sessionDataMap.get(sessionId);
  if (!session) return;
  renamingSessionId = sessionId;
  renameInput.value = session.customName || session.topic || session.slug || "";
  renameModal.classList.remove("hidden");
  setTimeout(() => { renameInput.focus(); renameInput.select(); }, 50);
}

/** Hide rename modal */
function hideRenameModal() {
  renameModal.classList.add("hidden");
  renamingSessionId = null;
}

/** Save the rename — POST to API and update local data */
async function saveRename() {
  const name = renameInput.value.trim();
  if (!name || !renamingSessionId) { hideRenameModal(); return; }

  const session = sessionDataMap.get(renamingSessionId);
  if (!session) { hideRenameModal(); return; }

  try {
    await fetch(`${session._machineUrl}/api/session/${encodeURIComponent(renamingSessionId)}/rename`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session._machineToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    });

    // Update local data
    session.customName = name;
    sessionDataMap.set(renamingSessionId, session);

    // Update displayed topic text inline (no full refresh)
    const card = sessionListEl.querySelector(`.session-card[data-session-id="${CSS.escape(renamingSessionId)}"]`);
    if (card) {
      const topicEl = card.querySelector(".session-card-topic");
      if (topicEl) topicEl.textContent = name;
      // For grouped cards, the name row shows the topic
      const nameEl = card.querySelector(".session-card-name");
      if (card.classList.contains("grouped") && nameEl) nameEl.textContent = name;
    }
  } catch {
    // ignore errors silently
  }

  hideRenameModal();
}

/** Render the project list in the picker modal */
function renderProjectList(projects) {
  if (projects.length === 0) {
    projectList.innerHTML = '<p class="sessions-empty">No known projects</p>';
    return;
  }

  // Favorites first, then others
  const favorites = projects.filter((p) => p.isFavorite);
  const others = projects.filter((p) => !p.isFavorite);

  const showMachineBadges = machines.length > 1;
  let html = "";

  if (favorites.length > 0) {
    html += '<div class="project-section-label">Favorites</div>';
    html += favorites.map((p) => {
      const machLabel = showMachineBadges && p.machineName ? `<span class="machine-badge small" style="${machineColorStyle(p.machineName)}">${deviceIcon(p._machineType)} ${esc(p.machineName)}</span>` : "";
      return `
        <button class="project-item" data-path="${esc(p.path)}" data-name="${esc(p.name)}" data-machine-url="${esc(p._machineUrl)}" data-machine-token="${esc(p._machineToken)}" data-machine-name="${esc(p.machineName || "")}">
          <span class="project-item-star">&#9733;</span>
          <span>${esc(p.name)}</span>
          ${machLabel}
        </button>
      `;
    }).join("");
  }

  if (others.length > 0) {
    html += '<div class="project-section-label">Discovered</div>';
    html += others.map((p) => {
      const machLabel = showMachineBadges && p.machineName ? `<span class="machine-badge small" style="${machineColorStyle(p.machineName)}">${deviceIcon(p._machineType)} ${esc(p.machineName)}</span>` : "";
      return `
        <button class="project-item" data-path="${esc(p.path)}" data-name="${esc(p.name)}" data-machine-url="${esc(p._machineUrl)}" data-machine-token="${esc(p._machineToken)}" data-machine-name="${esc(p.machineName || "")}">
          <span>${esc(p.name)}</span>
          ${machLabel}
        </button>
      `;
    }).join("");
  }

  projectList.innerHTML = html;

  projectList.querySelectorAll(".project-item").forEach((item) => {
    item.addEventListener("click", () => {
      const path = item.dataset.path;
      const name = item.dataset.name;
      const machineUrl = item.dataset.machineUrl;
      const machineToken = item.dataset.machineToken;
      const machineName = item.dataset.machineName || undefined;
      hideProjectPicker();
      if (onNewSession) onNewSession(path, name, machineUrl, machineToken, machineName);
    });
  });
}

/** Escape HTML entities */
function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Dismiss a session via API */
async function dismissSessionAPI(sessionId) {
  const session = sessionDataMap.get(sessionId);
  if (!session) return;
  try {
    await fetch(`${session._machineUrl}/api/dismiss/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session._machineToken}` },
    });
  } catch {
    // ignore
  }
}

/** Restore a dismissed session */
async function undismissSessionAPI(sessionId, machineUrl, machineToken) {
  try {
    await fetch(`${machineUrl}/api/undismiss/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${machineToken}` },
    });
  } catch {
    // ignore
  }
  refreshSessions();
}

/** Track dismissed section expanded state */
let dismissedExpanded = false;

/** Fetch and render dismissed sessions section at the bottom of the list */
async function renderDismissedSection() {
  // Fetch dismissed from all machines
  const fetches = machines.map(async (machine) => {
    const res = await fetch(`${machine.url}/api/dismissed`, {
      headers: { Authorization: `Bearer ${machine.token}` },
    });
    if (!res.ok) return [];
    const sessions = await res.json();
    return sessions.map((s) => ({
      ...s,
      _machineUrl: machine.url,
      _machineToken: machine.token,
    }));
  });

  const results = await Promise.allSettled(fetches);
  let allDismissed = [];
  for (const r of results) {
    if (r.status === "fulfilled") allDismissed.push(...r.value);
  }

  if (allDismissed.length === 0) return;

  // Sort by most recent first
  allDismissed.sort((a, b) => b.lastTimestamp - a.lastTimestamp);

  const chevronClass = dismissedExpanded ? "chevron-open" : "";
  let html = `
    <div class="dismissed-section">
      <div class="dismissed-header" id="dismissed-toggle">
        <span>Recently Dismissed</span>
        <span class="dismissed-header-right">
          <span class="project-group-count">${allDismissed.length}</span>
          <span class="project-group-chevron ${chevronClass}">&#9662;</span>
        </span>
      </div>
      <div class="dismissed-list ${dismissedExpanded ? "" : "hidden"}" id="dismissed-list">
  `;

  for (const s of allDismissed) {
    const timeAgo = formatTimeAgo(s.lastTimestamp);
    html += `
      <div class="dismissed-card" data-session-id="${esc(s.sessionId)}"
           data-machine-url="${esc(s._machineUrl)}" data-machine-token="${esc(s._machineToken)}">
        <div class="dismissed-card-info">
          <span class="dismissed-card-name">${esc(s.projectName || "Unknown")}</span>
          <span class="dismissed-card-topic">${esc(s.customName || s.topic || s.slug)}</span>
        </div>
        <div class="dismissed-card-right">
          <span class="dismissed-card-time">${esc(timeAgo)}</span>
          <button class="dismissed-restore-btn">Restore</button>
        </div>
      </div>
    `;
  }

  html += `</div></div>`;
  sessionListEl.insertAdjacentHTML("beforeend", html);

  // Toggle expand/collapse
  document.getElementById("dismissed-toggle").addEventListener("click", () => {
    dismissedExpanded = !dismissedExpanded;
    const list = document.getElementById("dismissed-list");
    const chevron = document.querySelector(".dismissed-header .project-group-chevron");
    list.classList.toggle("hidden");
    if (chevron) chevron.classList.toggle("chevron-open");
  });

  // Restore buttons
  sessionListEl.querySelectorAll(".dismissed-restore-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const card = btn.closest(".dismissed-card");
      const sessionId = card.dataset.sessionId;
      const machineUrl = card.dataset.machineUrl;
      const machineToken = card.dataset.machineToken;
      // Fade out the card
      card.style.transition = "opacity 0.2s";
      card.style.opacity = "0";
      setTimeout(() => card.remove(), 200);
      undismissSessionAPI(sessionId, machineUrl, machineToken);
    });
  });
}

/** Attach swipe-left-to-dismiss + click-to-open on a card */
function attachSwipeToDismiss(card) {
  const wrapper = card.closest(".swipe-wrapper");
  if (!wrapper) return;

  let startX = 0;
  let startY = 0;
  let currentDx = 0;
  let didSwipe = false;
  let directionLocked = null; // "horizontal" | "vertical" | null

  // Normal click handler — blocked if user was swiping
  card.addEventListener("click", (e) => {
    if (didSwipe) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    const session = sessionDataMap.get(card.dataset.sessionId);
    if (session && onSessionSelect) onSessionSelect(session);
  }, { capture: false });

  card.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    currentDx = 0;
    didSwipe = false;
    directionLocked = null;
    card.style.transition = "none";
  }, { passive: true });

  card.addEventListener("touchmove", (e) => {
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    // Lock direction after 8px of movement
    if (!directionLocked) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        directionLocked = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
      }
      return;
    }

    // Vertical — let the browser scroll normally
    if (directionLocked === "vertical") return;

    // Horizontal swipe left
    if (dx < 0) {
      e.preventDefault();
      didSwipe = true;
      currentDx = dx;
      const offset = Math.max(dx, -200);
      card.style.transform = `translateX(${offset}px)`;
      // Show the red action behind
      wrapper.classList.add("swiping");
    }
  }, { passive: false });

  card.addEventListener("touchend", () => {
    if (!didSwipe) {
      card.style.transition = "";
      card.style.transform = "";
      wrapper.classList.remove("swiping");
      return;
    }

    card.style.transition = "transform 0.25s ease";

    if (currentDx < -80) {
      // Dismiss — slide all the way out
      card.style.transform = "translateX(-120%)";
      const sessionId = card.dataset.sessionId;
      setTimeout(() => {
        wrapper.style.height = wrapper.offsetHeight + "px";
        wrapper.style.overflow = "hidden";
        wrapper.style.transition = "height 0.2s, margin 0.2s";
        requestAnimationFrame(() => {
          wrapper.style.height = "0";
          wrapper.style.marginBottom = "0";
        });
      }, 250);
      dismissSessionAPI(sessionId);
    } else {
      // Snap back
      card.style.transform = "translateX(0)";
      setTimeout(() => { wrapper.classList.remove("swiping"); }, 250);
    }

    // Reset didSwipe after a tick so the click handler sees it
    setTimeout(() => { didSwipe = false; }, 300);
  });
}

/** Human-readable time ago */
function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
