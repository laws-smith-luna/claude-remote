/**
 * Main app entry — machine setup, initialization, navigation.
 * Phone-as-hub: connects to multiple servers, merges sessions client-side.
 */

import { initChat, setSession, setReadOnly, loadSessionHistory, loadHistory, loadMergedHistory, clearChat } from "./chat.js";
import { initSessionsUI, startRefresh, stopRefresh, refreshSessions } from "./sessions-ui.js";
import { initPermission } from "./permission.js";
import { loadMachines, saveMachines, addMachine, removeMachine, hasMachines, migrateFromLegacyAuth, getMachines } from "./machines.js";
import { MultiWS } from "./multi-ws.js";

const setupScreen = document.getElementById("setup-screen");
const appEl = document.getElementById("app");
const setupMachineList = document.getElementById("setup-machine-list");
const setupName = document.getElementById("setup-name");
const setupUrl = document.getElementById("setup-url");
const setupToken = document.getElementById("setup-token");
const setupAdd = document.getElementById("setup-add");
const setupContinue = document.getElementById("setup-continue");
const knownMachinesEl = document.getElementById("known-machines");
const knownMachinesGrid = document.getElementById("known-machines-grid");
const manualToggle = document.getElementById("manual-toggle");
const manualForm = document.getElementById("manual-form");

// Settings modal elements
const settingsModal = document.getElementById("settings-modal");
const settingsClose = document.getElementById("settings-modal-close");
const settingsMachineList = document.getElementById("settings-machine-list");
const settingsAddToggle = document.getElementById("settings-add-toggle");
const settingsAddSection = document.getElementById("settings-add-section");
const settingsToken = document.getElementById("settings-token");
const settingsKnownEl = document.getElementById("settings-known-machines");
const settingsKnownGrid = document.getElementById("settings-known-grid");
const settingsManualToggle = document.getElementById("settings-manual-toggle");
const settingsManualForm = document.getElementById("settings-manual-form");
const settingsAddName = document.getElementById("settings-add-name");
const settingsAddUrl = document.getElementById("settings-add-url");
const settingsAddBtn = document.getElementById("settings-add-btn");
const settingsSwVersion = document.getElementById("settings-sw-version");

const sessionListView = document.getElementById("session-list-view");
const chatView = document.getElementById("chat-view");
const backBtn = document.getElementById("back-btn");
const chatProject = document.getElementById("chat-project");
const chatStatus = document.getElementById("chat-status");
const chatBranch = document.getElementById("chat-branch");
const chatMachine = document.getElementById("chat-machine");
const machinesBtn = document.getElementById("machines-btn");
const notifyBtn = document.getElementById("notify-btn");
const connectionStatus = document.getElementById("connection-status");
const offlineBanner = document.getElementById("offline-banner");

let multiWs = null;
let currentWatchingSession = null;
let currentWatchingMachineUrl = null;

// --- Setup Screen ---

function checkMachines() {
  // Auto-migrate from old single-token auth
  migrateFromLegacyAuth();

  if (hasMachines()) {
    startApp();
  } else {
    showSetupScreen();
  }
}

function showSetupScreen() {
  setupScreen.classList.remove("hidden");
  appEl.classList.add("hidden");
  renderSetupMachineList();
  fetchKnownMachines();
}

function renderSetupMachineList() {
  const machines = getMachines();
  if (machines.length === 0) {
    setupMachineList.innerHTML = '<p class="setup-empty">No machines added yet</p>';
    setupContinue.classList.add("hidden");
    return;
  }

  setupContinue.classList.remove("hidden");
  setupMachineList.innerHTML = machines.map((m) => `
    <div class="setup-machine-item" data-url="${esc(m.url)}">
      <div class="setup-machine-info">
        <span class="setup-machine-name">${esc(m.name)}</span>
        <span class="setup-machine-url">${esc(m.url)}</span>
      </div>
      <button class="setup-machine-remove" data-url="${esc(m.url)}">&times;</button>
    </div>
  `).join("");

  // Attach remove handlers
  setupMachineList.querySelectorAll(".setup-machine-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeMachine(btn.dataset.url);
      renderSetupMachineList();
      // Update known machine checkmarks
      fetchKnownMachines();
    });
  });
}

// --- Known Machines (from server) ---

async function fetchKnownMachines() {
  let allKnown = [];

  // Try fetching from the current origin's API (works when served from a machine)
  const origin = `${location.protocol}//${location.host}`;
  try {
    const res = await fetch(`${origin}/api/known-machines`);
    if (res.ok) {
      const data = await res.json();
      if (data.self?.name) {
        allKnown.push({ name: data.self.name, url: origin });
      }
      if (data.peers?.length) {
        for (const peer of data.peers) {
          allKnown.push({ name: peer.name, url: peer.url.replace(/\/+$/, "") });
        }
      }
    }
  } catch {
    // Not served from a machine (e.g. GitHub Pages) — try static fallback
  }

  // Fallback: static known-machines.json baked in during deploy
  if (allKnown.length === 0) {
    try {
      const res = await fetch("./known-machines.json");
      if (res.ok) {
        allKnown = await res.json();
      }
    } catch { /* no static config available */ }
  }

  if (allKnown.length === 0) return;
  renderKnownMachines(allKnown);
}

function renderKnownMachines(knownList) {
  const machines = getMachines();
  const addedUrls = new Set(machines.map((m) => m.url));

  knownMachinesGrid.innerHTML = knownList.map((km) => {
    const isAdded = addedUrls.has(km.url);
    return `
      <div class="known-machine-card ${isAdded ? "added" : ""}"
           data-name="${esc(km.name)}" data-url="${esc(km.url)}">
        <div class="known-machine-card-info">
          <div class="known-machine-card-name">${esc(km.name)}</div>
          <div class="known-machine-card-url">${esc(km.url)}</div>
        </div>
        <span class="known-machine-card-check">&#10003;</span>
      </div>
    `;
  }).join("");

  knownMachinesEl.classList.remove("hidden");

  // Attach click handlers
  knownMachinesGrid.querySelectorAll(".known-machine-card").forEach((card) => {
    card.addEventListener("click", () => addKnownMachine(card));
  });
}

async function addKnownMachine(card) {
  if (card.classList.contains("added") || card.classList.contains("adding")) return;

  const token = setupToken.value.trim();
  if (!token) {
    // Shake the token input
    setupToken.classList.add("shake");
    setupToken.focus();
    setTimeout(() => setupToken.classList.remove("shake"), 400);
    return;
  }

  const name = card.dataset.name;
  const url = card.dataset.url;

  card.classList.add("adding");
  try {
    const res = await fetch(`${url}/api/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const displayName = info.machineName || name;
    addMachine(displayName, url, token, info.machineType);
    card.classList.remove("adding");
    card.classList.add("added");
    renderSetupMachineList();
  } catch (err) {
    card.classList.remove("adding");
    alert(`Failed to connect to ${name}: ${err.message}`);
  }
}

// --- Manual entry ---

manualToggle.addEventListener("click", () => {
  const isOpen = !manualForm.classList.contains("hidden");
  manualForm.classList.toggle("hidden");
  manualToggle.classList.toggle("open", !isOpen);
  manualToggle.textContent = isOpen ? "+ Add custom machine" : "- Hide custom form";
});

setupAdd.addEventListener("click", async () => {
  const name = setupName.value.trim();
  const url = setupUrl.value.trim();
  const token = setupToken.value.trim();

  if (!name || !url || !token) return;

  // Validate by fetching /api/info
  setupAdd.disabled = true;
  setupAdd.textContent = "Checking...";
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/api/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    // Use server-reported machine name if available
    const displayName = info.machineName || name;
    addMachine(displayName, url, token, info.machineType);
    setupName.value = "";
    setupUrl.value = "";
    renderSetupMachineList();
    // Re-render known machines to update checkmarks
    fetchKnownMachines();
  } catch (err) {
    alert(`Failed to connect: ${err.message}`);
  } finally {
    setupAdd.disabled = false;
    setupAdd.textContent = "Add Machine";
  }
});

setupContinue.addEventListener("click", () => {
  if (hasMachines()) startApp();
});

// Enter key in setup fields
[setupName, setupUrl].forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") setupAdd.click();
  });
});

// Enter key in token field — no specific action, just prevent form submit
setupToken.addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.preventDefault();
});

// --- App ---

async function startApp() {
  setupScreen.classList.add("hidden");
  appEl.classList.remove("hidden");

  const machines = getMachines();

  // Create MultiWS and connect to all machines
  multiWs = new MultiWS();

  // Initialize components with multiWs (same API as old single WS)
  initChat(multiWs, onStatusTransition);
  initSessionsUI(machines, multiWs, onSessionSelect, onNewSession);
  initPermission(multiWs);

  // Connect to each machine
  for (const machine of machines) {
    multiWs.connectMachine(machine);
  }

  // Show session list (home view)
  showSessionList();

  // Show notification button if permission not yet decided
  if ("Notification" in window && Notification.permission === "default") {
    notifyBtn.classList.remove("hidden");
  }

  // Live status updates — re-render settings if modal is open
  multiWs.on("_connection_change", (msg) => {
    updateConnectionStatus();

    const machines = getMachines();
    const m = machines.find((m) => m.url === msg.url);
    if (m) {
      m.online = msg.online;
      saveMachines(machines);
    }

    // Re-render settings machine list if modal is visible
    if (!settingsModal.classList.contains("hidden")) {
      renderSettingsMachineList();
    }
  });
}

function updateConnectionStatus() {
  if (!multiWs) return;
  const status = multiWs.getStatus();
  const online = status.filter((s) => s.online);
  const offline = status.filter((s) => !s.online);

  if (offline.length === 0) {
    connectionStatus.classList.add("hidden");
    document.querySelectorAll(".header").forEach((h) => h.classList.remove("disconnected"));
  } else if (online.length === 0) {
    connectionStatus.classList.remove("hidden");
    connectionStatus.textContent = `All machines offline`;
    connectionStatus.className = "connection-status all-offline";
    document.querySelectorAll(".header").forEach((h) => h.classList.add("disconnected"));
  } else {
    connectionStatus.classList.remove("hidden");
    connectionStatus.textContent = `${offline.map((s) => s.name).join(", ")} offline`;
    connectionStatus.className = "connection-status partial-offline";
    document.querySelectorAll(".header").forEach((h) => h.classList.remove("disconnected"));
  }
}

// --- Navigation ---

function showSessionList() {
  sessionListView.classList.remove("hidden");
  chatView.classList.add("hidden");
  startRefresh();

  // Stop watching if we were watching a session
  if (currentWatchingSession && currentWatchingMachineUrl) {
    multiWs.sendTo(currentWatchingMachineUrl, { type: "unwatch_session", sessionId: currentWatchingSession });
    currentWatchingSession = null;
    currentWatchingMachineUrl = null;
  }
}

function showChatView(session) {
  sessionListView.classList.add("hidden");
  chatView.classList.remove("hidden");
  stopRefresh();

  // Update header
  chatProject.textContent = session.projectName || session.name || "New Session";
  chatBranch.textContent = session.branch || "";

  // Show machine label if from a specific machine
  if (chatMachine) {
    if (session.machineName) {
      chatMachine.textContent = session.machineName;
      chatMachine.classList.remove("hidden");
    } else {
      chatMachine.textContent = "";
      chatMachine.classList.add("hidden");
    }
  }

  if (session.status) {
    chatStatus.textContent = session.status;
    chatStatus.className = `chat-status-badge status-${session.status}`;
  } else {
    chatStatus.textContent = "new";
    chatStatus.className = "chat-status-badge status-new";
  }
}

// Back button
backBtn.addEventListener("click", () => {
  showSessionList();
});

// Swipe right on chat view → slide away to reveal session list
{
  let startX = 0;
  let startY = 0;
  let tracking = false;   // true once we decide this is a horizontal swipe
  let decided = false;     // true once we've decided horizontal vs vertical

  chatView.addEventListener("touchstart", (e) => {
    // Don't start swipe if interacting with input
    if (e.target.closest("#input-bar, #readonly-bar")) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    tracking = false;
    decided = false;
    // Reveal session list underneath (but keep it invisible until we move)
    sessionListView.classList.remove("hidden");
    sessionListView.style.position = "absolute";
    sessionListView.style.inset = "0";
    sessionListView.style.zIndex = "1";
  }, { passive: true });

  chatView.addEventListener("touchmove", (e) => {
    if (decided && !tracking) return; // vertical scroll — bail
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    if (!decided) {
      // Need at least 10px movement to decide direction
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      decided = true;
      if (Math.abs(dx) > Math.abs(dy) && dx > 0) {
        tracking = true;
        chatView.classList.add("swiping");
        // Dismiss keyboard immediately so it doesn't jump on navigation
        if (document.activeElement) document.activeElement.blur();
      } else {
        // Vertical scroll — clean up
        sessionListView.style.position = "";
        sessionListView.style.inset = "";
        sessionListView.style.zIndex = "";
        sessionListView.classList.add("hidden");
        return;
      }
    }

    if (tracking) {
      const offset = Math.max(0, dx);
      chatView.style.transform = `translateX(${offset}px)`;
    }
  }, { passive: true });

  chatView.addEventListener("touchend", (e) => {
    if (!tracking) {
      // Clean up if we never started tracking
      sessionListView.style.position = "";
      sessionListView.style.inset = "";
      sessionListView.style.zIndex = "";
      if (chatView.classList.contains("hidden")) return;
      if (!sessionListView.classList.contains("hidden") && !tracking) {
        sessionListView.classList.add("hidden");
      }
      return;
    }

    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const threshold = window.innerWidth * 0.35;

    chatView.classList.remove("swiping");

    if (dx > threshold) {
      // Complete the swipe — slide away
      chatView.classList.add("snap-away");
      chatView.addEventListener("transitionend", function onEnd() {
        chatView.removeEventListener("transitionend", onEnd);
        chatView.classList.remove("snap-away");
        chatView.style.transform = "";
        sessionListView.style.position = "";
        sessionListView.style.inset = "";
        sessionListView.style.zIndex = "";
        showSessionList();
      }, { once: true });
    } else {
      // Snap back
      chatView.classList.add("snap-back");
      chatView.addEventListener("transitionend", function onEnd() {
        chatView.removeEventListener("transitionend", onEnd);
        chatView.classList.remove("snap-back");
        chatView.style.transform = "";
        sessionListView.style.position = "";
        sessionListView.style.inset = "";
        sessionListView.style.zIndex = "";
        sessionListView.classList.add("hidden");
      }, { once: true });
    }

    tracking = false;
    decided = false;
  }, { passive: true });
}

// --- Session selection ---

async function onSessionSelect(session) {
  setSession(session);
  showChatView(session);
  clearChat();

  // Resolve the machine for this session
  const machineUrl = session._machineUrl;
  const machineToken = session._machineToken;

  if (session.status === "running") {
    // Read-only live feed mode
    setReadOnly(true);

    // Load recent history from JSONL
    try {
      const res = await fetch(`${machineUrl}/api/session/${encodeURIComponent(session.sessionId)}/history`, {
        headers: { Authorization: `Bearer ${machineToken}` },
      });
      if (res.ok) {
        const entries = await res.json();
        loadSessionHistory(entries);
      }
    } catch {
      // ignore
    }

    // Start watching for live updates on the correct machine
    multiWs.sendTo(machineUrl, { type: "watch_session", sessionId: session.sessionId });
    currentWatchingSession = session.sessionId;
    currentWatchingMachineUrl = machineUrl;
  } else {
    // Interactive mode (waiting/idle)
    setReadOnly(false);

    let loaded = false;

    // Use merged history for sessions that have children (CLI sessions with web forks)
    // or for any session to get a unified view
    if (session.childSessionIds?.length > 0 || !session.isWebSession) {
      loaded = await loadMergedHistory(session.sessionId, machineUrl, machineToken);
    }

    // Fallback: load web messages if merged didn't work or for pure web sessions
    if (!loaded && session.isWebSession) {
      await loadHistory(session.sessionId, machineUrl, machineToken);
      loaded = true;
    }

    // Show welcome message if no history was loaded
    if (!loaded) {
      showWelcomeMessage(session);
    }
  }
}

/** Called when user starts a new session from project picker */
function onNewSession(projectDir, projectName, machineUrl, machineToken, machineName) {
  const session = {
    sessionId: null,
    projectDir,
    projectName,
    branch: "",
    status: null,
    isNew: true,
    isWebSession: true,
    machineName: machineName || undefined,
    _machineUrl: machineUrl,
    _machineToken: machineToken,
  };

  setSession(session);
  showChatView(session);
  clearChat();
  setReadOnly(false);
  showWelcomeMessage(session);
}

/** Show a formatted welcome message */
function showWelcomeMessage(session) {
  const name = session.projectName || "Project";
  const md = `### ${name}\n\nReady to go. Type a message to start a **Claude Code** session.\n\n- Resume existing sessions from the session list\n- Use \`/cancel\` to stop a running query\n- Use \`/status\` to check session info`;
  const el = document.createElement("div");
  el.className = "msg msg-system welcome-msg";
  el.innerHTML = window.renderMarkdown(md);
  document.getElementById("messages").appendChild(el);
}

/** Called when a running session transitions to waiting/idle */
function onStatusTransition(newStatus) {
  // Stop watching the JSONL
  if (currentWatchingSession && currentWatchingMachineUrl) {
    multiWs.sendTo(currentWatchingMachineUrl, { type: "unwatch_session", sessionId: currentWatchingSession });
    currentWatchingSession = null;
    currentWatchingMachineUrl = null;
  }

  // Dismissed — navigate back to session list
  if (newStatus === "dismissed") {
    showSessionList();
    return;
  }

  // Update the status badge
  chatStatus.textContent = newStatus;
  chatStatus.className = `chat-status-badge status-${newStatus}`;
}

// --- Settings Modal ---

function openSettingsModal() {
  settingsModal.classList.remove("hidden");
  renderSettingsMachineList();
  fetchSwVersion();
  // Reset add section
  settingsAddSection.classList.add("hidden");
  settingsAddToggle.textContent = "+ Add machine";
  settingsAddToggle.classList.remove("open");
}

function closeSettingsModal() {
  settingsModal.classList.add("hidden");
}

// Close handlers
settingsClose.addEventListener("click", closeSettingsModal);
settingsModal.querySelector(".modal-backdrop").addEventListener("click", closeSettingsModal);

function renderSettingsMachineList() {
  const machines = getMachines();
  const status = multiWs ? multiWs.getStatus() : [];
  const statusMap = new Map(status.map((s) => [s.url, s.online]));

  if (machines.length === 0) {
    settingsMachineList.innerHTML = '<p class="setup-empty">No machines configured</p>';
    return;
  }

  settingsMachineList.innerHTML = machines.map((m) => {
    const online = statusMap.get(m.url) || false;
    const icon = getDeviceIcon(m.type);
    return `
      <div class="settings-machine-card">
        <div class="settings-machine-status ${online ? "online" : "offline"}"></div>
        <span class="settings-machine-icon">${icon}</span>
        <div class="settings-machine-info">
          <span class="settings-machine-name">${esc(m.name)}</span>
          <span class="settings-machine-url">${esc(m.url)}</span>
        </div>
        <div class="settings-machine-actions">
          <button class="stop-btn" data-url="${esc(m.url)}" ${online ? "" : "disabled"}>Stop</button>
          <button class="remove-btn" data-url="${esc(m.url)}" title="Remove">&times;</button>
        </div>
      </div>
    `;
  }).join("");

  // Attach stop handlers
  settingsMachineList.querySelectorAll(".stop-btn").forEach((btn) => {
    btn.addEventListener("click", () => stopMachine(btn.dataset.url));
  });

  // Attach remove handlers
  settingsMachineList.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => removeSettingsMachine(btn.dataset.url));
  });
}

function getDeviceIcon(type) {
  return type === "laptop" ? "\u{1F4BB}" : "\u{1F5A5}\uFE0F";
}

async function stopMachine(url) {
  const machines = getMachines();
  const machine = machines.find((m) => m.url === url);
  if (!machine) return;

  if (!confirm(`Stop the remote server on ${machine.name}?\n\nThis will shut down Claude Remote on that computer.`)) return;

  // Show "Requested..." state
  const btn = settingsMachineList.querySelector(`.stop-btn[data-url="${CSS.escape(url)}"]`);
  if (btn) {
    btn.textContent = "Requested...";
    btn.disabled = true;
  }

  let sent = false;
  try {
    const resp = await fetch(`${url}/api/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${machine.token}` },
    });
    if (resp.ok) sent = true;
  } catch {
    // Server may die before response completes — still counts as sent
    sent = true;
  }

  if (!sent) {
    if (btn) { btn.textContent = "Stop"; btn.disabled = false; }
    return;
  }

  // Poll until the server is actually offline, then re-render
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    try {
      const resp = await fetch(`${url}/api/identity`, { signal: AbortSignal.timeout(2000) });
      if (!resp.ok) throw new Error();
      // Still alive, keep polling
    } catch {
      // Server is down
      clearInterval(poll);
      renderSettingsMachineList();
    }
    if (attempts >= 10) {
      clearInterval(poll);
      renderSettingsMachineList();
    }
  }, 1000);
}

function removeSettingsMachine(url) {
  if (multiWs) multiWs.disconnectMachine(url);
  removeMachine(url);

  // If no machines left, go to setup screen
  if (!hasMachines()) {
    closeSettingsModal();
    showSetupScreen();
    return;
  }

  renderSettingsMachineList();
}

// Add machine toggle
settingsAddToggle.addEventListener("click", () => {
  const isOpen = !settingsAddSection.classList.contains("hidden");
  settingsAddSection.classList.toggle("hidden");
  settingsAddToggle.classList.toggle("open", !isOpen);
  settingsAddToggle.textContent = isOpen ? "+ Add machine" : "- Hide add machine";
  if (!isOpen) fetchSettingsKnownMachines();
});

// Manual form toggle inside settings
settingsManualToggle.addEventListener("click", () => {
  const isOpen = !settingsManualForm.classList.contains("hidden");
  settingsManualForm.classList.toggle("hidden");
  settingsManualToggle.classList.toggle("open", !isOpen);
  settingsManualToggle.textContent = isOpen ? "+ Add custom machine" : "- Hide custom form";
});

// Add custom machine from settings
settingsAddBtn.addEventListener("click", async () => {
  const name = settingsAddName.value.trim();
  const url = settingsAddUrl.value.trim();
  const token = settingsToken.value.trim();
  if (!name || !url || !token) return;

  settingsAddBtn.disabled = true;
  settingsAddBtn.textContent = "Checking...";
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/api/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const displayName = info.machineName || name;
    addMachine(displayName, url, token, info.machineType);
    if (multiWs) {
      multiWs.connectMachine({ name: displayName, url: url.replace(/\/+$/, ""), token, type: info.machineType });
    }
    settingsAddName.value = "";
    settingsAddUrl.value = "";
    renderSettingsMachineList();
    fetchSettingsKnownMachines();
  } catch (err) {
    alert(`Failed to connect: ${err.message}`);
  } finally {
    settingsAddBtn.disabled = false;
    settingsAddBtn.textContent = "Add Machine";
  }
});

[settingsAddName, settingsAddUrl].forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") settingsAddBtn.click();
  });
});

async function fetchSettingsKnownMachines() {
  // Try fetching from any connected machine
  const machines = getMachines();
  let allKnown = [];

  for (const m of machines) {
    try {
      const res = await fetch(`${m.url}/api/known-machines`, {
        headers: { Authorization: `Bearer ${m.token}` },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.self?.name) allKnown.push({ name: data.self.name, url: m.url });
      if (data.peers?.length) {
        for (const peer of data.peers) {
          allKnown.push({ name: peer.name, url: peer.url.replace(/\/+$/, "") });
        }
      }
      break; // Got data from one machine
    } catch { /* continue */ }
  }

  // Also try from origin
  if (allKnown.length === 0) {
    const origin = `${location.protocol}//${location.host}`;
    try {
      const res = await fetch(`${origin}/api/known-machines`);
      if (res.ok) {
        const data = await res.json();
        if (data.self?.name) allKnown.push({ name: data.self.name, url: origin });
        if (data.peers?.length) {
          for (const peer of data.peers) {
            allKnown.push({ name: peer.name, url: peer.url.replace(/\/+$/, "") });
          }
        }
      }
    } catch { /* ignore */ }
  }

  if (allKnown.length === 0) {
    settingsKnownEl.classList.add("hidden");
    return;
  }

  const addedUrls = new Set(machines.map((m) => m.url));
  settingsKnownGrid.innerHTML = allKnown.map((km) => {
    const isAdded = addedUrls.has(km.url);
    return `
      <div class="known-machine-card ${isAdded ? "added" : ""}"
           data-name="${esc(km.name)}" data-url="${esc(km.url)}">
        <div class="known-machine-card-info">
          <div class="known-machine-card-name">${esc(km.name)}</div>
          <div class="known-machine-card-url">${esc(km.url)}</div>
        </div>
        <span class="known-machine-card-check">&#10003;</span>
      </div>
    `;
  }).join("");

  settingsKnownEl.classList.remove("hidden");

  settingsKnownGrid.querySelectorAll(".known-machine-card").forEach((card) => {
    card.addEventListener("click", () => addSettingsKnownMachine(card));
  });
}

async function addSettingsKnownMachine(card) {
  if (card.classList.contains("added") || card.classList.contains("adding")) return;

  const token = settingsToken.value.trim();
  if (!token) {
    settingsToken.classList.add("shake");
    settingsToken.focus();
    setTimeout(() => settingsToken.classList.remove("shake"), 400);
    return;
  }

  const name = card.dataset.name;
  const url = card.dataset.url;

  card.classList.add("adding");
  try {
    const res = await fetch(`${url}/api/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const displayName = info.machineName || name;
    addMachine(displayName, url, token, info.machineType);
    if (multiWs) {
      multiWs.connectMachine({ name: displayName, url, token, type: info.machineType });
    }
    card.classList.remove("adding");
    card.classList.add("added");
    renderSettingsMachineList();
  } catch (err) {
    card.classList.remove("adding");
    alert(`Failed to connect to ${name}: ${err.message}`);
  }
}

async function parseSwVersionFromText() {
  const res = await fetch("./sw.js");
  const text = await res.text();
  const match = text.match(/CACHE_NAME\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

async function fetchSwVersion() {
  let version = "unknown";

  if (navigator.serviceWorker?.controller) {
    try {
      const result = await new Promise((resolve, reject) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => resolve(e.data);
        setTimeout(() => reject(new Error("timeout")), 2000);
        navigator.serviceWorker.controller.postMessage({ type: "get_version" }, [ch.port2]);
      });
      if (result?.cacheName) version = result.cacheName;
    } catch {
      try { version = await parseSwVersionFromText() || version; } catch { /* ignore */ }
    }
  } else {
    try { version = await parseSwVersionFromText() || version; } catch { /* ignore */ }
  }

  settingsSwVersion.textContent = `SW: ${version}`;
}

// --- Service Worker ---

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/claude-remote/sw.js").catch((err) => {
    console.warn("SW registration failed:", err);
  });
}

// --- Helpers ---

function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- One-time button listeners (safe from startApp re-entry) ---

machinesBtn.addEventListener("click", () => openSettingsModal());

notifyBtn.addEventListener("click", async () => {
  const perm = await Notification.requestPermission();
  if (perm === "granted" || perm === "denied") {
    notifyBtn.classList.add("hidden");
  }
});

// --- Start ---

checkMachines();
