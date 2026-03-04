/**
 * Chat UI — message rendering, streaming assembly, input handling.
 * Supports both interactive mode (SDK queries) and read-only mode (live JSONL feed).
 * Routes messages to correct machine via multiWs.sendTo().
 */

import { cacheHistory, getCachedHistory, queueOutgoing } from "./offline-store.js";

const messagesEl = document.getElementById("messages");
const chatArea = document.getElementById("chat-area");
const inputEl = document.getElementById("msg-input");
const sendBtn = document.getElementById("send-btn");
const inputBar = document.getElementById("input-bar");
const readonlyBar = document.getElementById("readonly-bar");
const takeoverBtn = document.getElementById("takeover-btn");

// State
let streamingDiv = null;
let streamingText = "";
let streamingBlocks = [];
let toolStatuses = new Map();
let readOnly = false;
let currentSession = null;
let onStatusTransition = null;  // callback when session transitions from running to interactive
let webQueryPending = false;  // true when a query was sent from this web app
let queryInFlight = false;  // true while a query is actively streaming (blocks input)
let multiWs = null;

/** Deduplication: track last 200 message keys to skip duplicates on replay */
const seenMessages = new Set();
const MAX_SEEN = 200;

function trackSeen(key) {
  seenMessages.add(key);
  if (seenMessages.size > MAX_SEEN) {
    const first = seenMessages.values().next().value;
    seenMessages.delete(first);
  }
}

function isSeen(key) {
  return seenMessages.has(key);
}

/** Initialize chat event handlers */
export function initChat(ws, onStatusChange) {
  multiWs = ws;
  onStatusTransition = onStatusChange;

  sendBtn.addEventListener("click", () => sendMessage());
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
  });

  // WebSocket event handlers for streaming (interactive mode)
  ws.on("stream", handleStream);
  ws.on("assistant", handleAssistant);
  ws.on("tool_progress", handleToolProgress);
  ws.on("tool_summary", handleToolSummary);
  ws.on("result", handleResult);
  ws.on("error", handleError);
  ws.on("init", handleInit);
  ws.on("query_started", handleQueryStarted);
  ws.on("shortcut_result", handleShortcutResult);
  ws.on("status", handleStatus);

  // Live feed handlers (read-only mode)
  ws.on("live_entry", handleLiveEntry);
  ws.on("live_status", handleLiveStatus);

  // Take Over button — break out of live feed into interactive mode
  takeoverBtn.addEventListener("click", () => {
    if (!currentSession) return;
    setReadOnly(false);
    if (onStatusTransition) onStatusTransition("waiting");
  });
}

/** Set the current session context */
export function setSession(session) {
  currentSession = session;
  seenMessages.clear();
}

/** Get the current session */
export function getSession() {
  return currentSession;
}

/** Toggle read-only mode */
export function setReadOnly(isReadOnly) {
  readOnly = isReadOnly;
  if (isReadOnly) {
    inputBar.classList.add("hidden");
    readonlyBar.classList.remove("hidden");
  } else {
    inputBar.classList.remove("hidden");
    readonlyBar.classList.add("hidden");
    inputEl.focus();
  }
}

/** Send a message — routes to correct machine */
function sendMessage() {
  if (readOnly) return;
  if (queryInFlight) return; // Block input while a query is streaming

  const text = inputEl.value.trim();
  if (!text) return;
  if (!currentSession) {
    addSystemMessage("No session selected.");
    return;
  }

  inputEl.value = "";
  inputEl.style.height = "auto";

  const machineUrl = currentSession._machineUrl;

  // Check for shortcuts
  if (text.startsWith("/") || text.startsWith("n.") || text.startsWith("n ")) {
    if (text.startsWith("/agent ")) {
      const prompt = text.slice(7).trim();
      if (prompt) {
        addUserMessage(text);
        const msg = {
          type: "agent_query",
          prompt,
          requestId: generateId(),
        };
        if (!multiWs.sendTo(machineUrl, msg)) {
          queueOutgoing(machineUrl, msg);
          addSystemMessage("Queued — machine offline");
        }
      }
      return;
    }

    if (text === "/cancel") {
      multiWs.sendTo(machineUrl, { type: "cancel", sessionId: currentSession.sessionId });
      return;
    }

    multiWs.sendTo(machineUrl, { type: "shortcut", text, repo: currentSession.projectName, sessionId: currentSession.sessionId });

    // /exit navigates back after sending
    if (text === "/exit" && onStatusTransition) {
      onStatusTransition("dismissed");
    }
    return;
  }

  addUserMessage(text);

  // Block further input until this query completes
  queryInFlight = true;
  sendBtn.disabled = true;
  inputEl.disabled = true;

  if (currentSession.isNew) {
    // New session — send new_session message
    webQueryPending = true;
    const newMsg = {
      type: "new_session",
      projectDir: currentSession.projectDir,
      prompt: text,
      requestId: generateId(),
    };
    if (!multiWs.sendTo(machineUrl, newMsg)) {
      queueOutgoing(machineUrl, newMsg);
      addSystemMessage("Queued — machine offline");
      unlockInput();
    }
    // After first message, it's no longer "new"
    currentSession.isNew = false;
  } else {
    // Existing session — resume
    webQueryPending = true;
    const resumeMsg = {
      type: "resume_session",
      sessionId: currentSession.sessionId,
      prompt: text,
      requestId: generateId(),
    };
    if (!multiWs.sendTo(machineUrl, resumeMsg)) {
      queueOutgoing(machineUrl, resumeMsg);
      addSystemMessage("Queued — machine offline");
      unlockInput();
    }
  }
}

/** Add a user message bubble */
function addUserMessage(text) {
  const div = document.createElement("div");
  div.className = "msg msg-user";
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

/** Add an assistant message bubble (final, rendered) */
function addAssistantMessage(html, meta) {
  const div = document.createElement("div");
  div.className = "msg msg-assistant";
  div.innerHTML = html;
  if (meta) {
    const metaEl = document.createElement("div");
    metaEl.className = "msg-meta";
    metaEl.textContent = meta;
    div.appendChild(metaEl);
  }
  messagesEl.appendChild(div);
  scrollToBottom();
}

/** Add a system info message */
function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "msg msg-system";
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

/** Load session history from JSONL entries */
export function loadSessionHistory(entries) {
  messagesEl.innerHTML = "";
  resetStreamingState();

  for (const entry of entries) {
    if (entry.type === "user" && typeof entry.message?.content === "string") {
      addUserMessage(entry.message.content);
    } else if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
      // Extract text content from assistant message
      const textBlocks = entry.message.content.filter((c) => c.type === "text");
      const text = textBlocks.map((b) => b.text).join("\n");
      if (text) {
        addAssistantMessage(window.renderMarkdown(text));
      }
    }
  }
}

/** Load merged history (CLI JSONL + web messages combined) — uses absolute URL */
export async function loadMergedHistory(sessionId, machineUrl, machineToken) {
  messagesEl.innerHTML = "";
  resetStreamingState();

  try {
    const res = await fetch(`${machineUrl}/api/session/${encodeURIComponent(sessionId)}/merged-history`, {
      headers: { Authorization: `Bearer ${machineToken}` },
    });
    if (!res.ok) return false;
    const entries = await res.json();
    if (entries.length === 0) return false;

    // Cache for offline use
    cacheHistory(sessionId, entries);

    for (const entry of entries) {
      if (entry.role === "user") {
        const div = document.createElement("div");
        div.className = "msg msg-user";
        div.textContent = entry.content;
        if (entry.source === "web") {
          const badge = document.createElement("span");
          badge.className = "msg-source-badge";
          badge.textContent = "phone";
          div.prepend(badge);
        }
        messagesEl.appendChild(div);
      } else if (entry.role === "assistant") {
        const meta = formatMeta(entry.cost, entry.duration);
        addAssistantMessage(window.renderMarkdown(entry.content), meta);
      } else {
        addSystemMessage(entry.content);
      }
    }
    scrollToBottom();
    return true;
  } catch {
    // Try cached history
    try {
      const cached = await getCachedHistory(sessionId);
      if (cached && cached.length > 0) {
        for (const entry of cached) {
          if (entry.role === "user") {
            addUserMessage(entry.content);
          } else if (entry.role === "assistant") {
            addAssistantMessage(window.renderMarkdown(entry.content), formatMeta(entry.cost, entry.duration));
          } else {
            addSystemMessage(entry.content);
          }
        }
        addSystemMessage("Showing cached history (offline)");
        scrollToBottom();
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }
}

/** Load web session message history — uses absolute URL */
export async function loadHistory(sessionId, machineUrl, machineToken) {
  messagesEl.innerHTML = "";
  resetStreamingState();

  try {
    const res = await fetch(`${machineUrl}/api/messages/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${machineToken}` },
    });
    if (!res.ok) return;
    const messages = await res.json();

    // Cache for offline
    cacheHistory(sessionId, messages);

    for (const msg of messages) {
      if (msg.role === "user") {
        addUserMessage(msg.content);
      } else if (msg.role === "assistant") {
        const meta = formatMeta(msg.cost, msg.duration);
        addAssistantMessage(window.renderMarkdown(msg.content), meta);
      } else {
        addSystemMessage(msg.content);
      }
    }
  } catch {
    // Try cached
    try {
      const cached = await getCachedHistory(sessionId);
      if (cached && cached.length > 0) {
        for (const entry of cached) {
          if (entry.role === "user") {
            addUserMessage(entry.content);
          } else if (entry.role === "assistant") {
            addAssistantMessage(window.renderMarkdown(entry.content), formatMeta(entry.cost, entry.duration));
          } else {
            addSystemMessage(entry.content);
          }
        }
        addSystemMessage("Showing cached history (offline)");
      }
    } catch { /* ignore */ }
  }
}

/** Clear the chat display */
export function clearChat() {
  messagesEl.innerHTML = "";
  resetStreamingState();
  queryInFlight = false;
  sendBtn.disabled = false;
  inputEl.disabled = false;
  seenMessages.clear();
}

// --- Live entry handler (read-only mode) ---

function handleLiveEntry(msg) {
  if (!currentSession || msg.sessionId !== currentSession.sessionId) return;

  // Dedup by UUID or content
  const entry = msg.entry;
  const dedupKey = entry.uuid || `${entry.type}_${JSON.stringify(entry.message?.content || "").slice(0, 100)}`;
  if (isSeen(dedupKey)) return;
  trackSeen(dedupKey);

  if (entry.type === "user" && typeof entry.message?.content === "string") {
    addUserMessage(entry.message.content);
  } else if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
    const textBlocks = entry.message.content.filter((c) => c.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n");
    if (text) {
      addAssistantMessage(window.renderMarkdown(text));
    }

    // Show tool use info
    const toolUses = entry.message.content.filter((c) => c.type === "tool_use");
    for (const tool of toolUses) {
      addToolInfoLine(tool.name, tool.input);
    }
  } else if (entry.type === "result") {
    addSystemMessage(`Result: ${entry.subtype || "complete"}`);
  }
}

function handleLiveStatus(msg) {
  if (!currentSession || msg.sessionId !== currentSession.sessionId) return;

  // Update status badge
  const statusBadge = document.getElementById("chat-status");
  if (statusBadge) {
    statusBadge.textContent = msg.status;
    statusBadge.className = `chat-status-badge status-${msg.status}`;
  }

  // If session stopped running, transition to interactive
  if (msg.status !== "running" && readOnly) {
    setReadOnly(false);
    addSystemMessage("Session finished. You can now send messages.");
    if (onStatusTransition) onStatusTransition(msg.status);

    // Notification when backgrounded
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      const name = currentSession.projectName || "Session";
      new Notification("Claude Remote", {
        body: `${name} finished`,
        icon: "/icons/icon-192.svg",
        tag: `session-${msg.sessionId}`,
      });
    }
  }
}

/** Add a tool info line in live feed mode */
function addToolInfoLine(toolName, input) {
  const div = document.createElement("div");
  div.className = "tool-info-line";
  let detail = "";
  if (input?.command) detail = input.command.slice(0, 60);
  else if (input?.file_path) detail = input.file_path.split(/[/\\]/).pop();
  else if (input?.pattern) detail = input.pattern;
  div.textContent = `${toolName}${detail ? ": " + detail : ""}`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

// --- Stream event handlers (interactive mode) ---

function handleQueryStarted(_msg) {
  startStreaming();
}

function handleInit(msg) {
  // Capture sessionId early (before result) so resume works if needed
  if (msg.sessionId && currentSession && !currentSession.sessionId) {
    currentSession.sessionId = msg.sessionId;
  }
  if (streamingDiv) {
    const modelTag = streamingDiv.querySelector(".stream-model");
    if (modelTag) modelTag.textContent = msg.model || "";
  }
}

function handleStream(msg) {
  const event = msg.event;
  if (!event) return;

  if (!streamingDiv) startStreaming();

  if (event.type === "content_block_start") {
    if (event.content_block?.type === "tool_use") {
      const toolName = event.content_block.name || "Tool";
      addToolStatus(event.content_block.id, `Using ${toolName}...`);
    }
  } else if (event.type === "content_block_delta") {
    if (event.delta?.type === "text_delta" && event.delta.text) {
      streamingText += event.delta.text;
      updateStreamingContent();
    }
  }
}

function handleAssistant(_msg) {
  finalizeStreaming();
}

function handleToolProgress(msg) {
  if (!streamingDiv) startStreaming();
  const elapsed = msg.elapsed?.toFixed(1) || "?";
  updateToolStatus(msg.toolUseId, `${msg.toolName} (${elapsed}s)...`);
}

function handleToolSummary(msg) {
  addToolSummaryLine(msg.summary);
}

function handleResult(msg) {
  finalizeStreaming();
  unlockInput();

  const meta = formatMeta(msg.totalCostUsd, msg.durationMs);
  if (meta) {
    const metaEl = document.createElement("div");
    metaEl.className = "msg-meta standalone";
    metaEl.textContent = meta;
    messagesEl.appendChild(metaEl);
    scrollToBottom();
  }

  if (msg.isError && msg.errors) {
    addSystemMessage("Error: " + msg.errors.join(", "));
  }

  // Update session ID if we got one back (for new sessions)
  if (msg.sessionId && currentSession) {
    currentSession.sessionId = msg.sessionId;
  }

  // Show handoff indicator only for queries sent from this web app
  if (webQueryPending) {
    webQueryPending = false;
    addSystemMessage("Activity logged for CLI handoff");
  }

  // Notification when backgrounded
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    const name = currentSession?.projectName || "Session";
    new Notification("Claude Remote", {
      body: `${name} — query complete`,
      icon: "/icons/icon-192.svg",
      tag: `result-${msg.requestId}`,
    });
  }
}

function handleError(msg) {
  finalizeStreaming();
  unlockInput();
  addSystemMessage("Error: " + (msg.error || "Unknown error"));
}

/** Re-enable input after a query completes */
function unlockInput() {
  queryInFlight = false;
  sendBtn.disabled = false;
  inputEl.disabled = false;
  inputEl.focus();
}

function handleShortcutResult(msg) {
  if (msg.text) {
    addAssistantMessage(window.renderMarkdown(msg.text));
  }
}

function handleStatus(msg) {
  if (msg.status === "compacting") {
    addSystemMessage("Compacting context...");
  }
}

// --- Streaming helpers ---

function resetStreamingState() {
  streamingDiv = null;
  streamingText = "";
  streamingBlocks = [];
  toolStatuses.clear();
}

function startStreaming() {
  if (streamingDiv) return;

  streamingText = "";
  streamingBlocks = [];
  toolStatuses.clear();

  streamingDiv = document.createElement("div");
  streamingDiv.className = "msg msg-assistant streaming";
  streamingDiv.innerHTML = '<span class="stream-model"></span><div class="stream-content"></div><div class="stream-tools"></div><div class="stream-cursor"></div>';
  messagesEl.appendChild(streamingDiv);
  scrollToBottom();
}

function updateStreamingContent() {
  if (!streamingDiv) return;
  const contentEl = streamingDiv.querySelector(".stream-content");
  if (contentEl) {
    contentEl.innerHTML = window.renderMarkdown(streamingText);
    scrollToBottom();
  }
}

function addToolStatus(toolUseId, text) {
  if (!streamingDiv) return;
  const toolsEl = streamingDiv.querySelector(".stream-tools");
  if (!toolsEl) return;

  let el = toolStatuses.get(toolUseId);
  if (!el) {
    el = document.createElement("div");
    el.className = "tool-status";
    toolsEl.appendChild(el);
    toolStatuses.set(toolUseId, el);
  }
  el.textContent = text;
  scrollToBottom();
}

function updateToolStatus(toolUseId, text) {
  if (!streamingDiv) return;
  let el = toolStatuses.get(toolUseId);
  if (el) {
    el.textContent = text;
    return;
  }
  addToolStatus(toolUseId, text);
}

function addToolSummaryLine(summary) {
  if (!streamingDiv) return;
  const toolsEl = streamingDiv.querySelector(".stream-tools");
  if (!toolsEl) return;

  const el = document.createElement("div");
  el.className = "tool-summary";
  el.textContent = summary;
  toolsEl.appendChild(el);
  scrollToBottom();
}

function finalizeStreaming() {
  if (!streamingDiv) return;

  const cursor = streamingDiv.querySelector(".stream-cursor");
  if (cursor) cursor.remove();

  streamingDiv.classList.remove("streaming");

  if (streamingText) {
    const contentEl = streamingDiv.querySelector(".stream-content");
    if (contentEl) {
      contentEl.innerHTML = window.renderMarkdown(streamingText);
    }
  }

  resetStreamingState();
}

function formatMeta(cost, durationMs) {
  const parts = [];
  if (cost !== undefined && cost !== null) {
    parts.push(`$${cost.toFixed(4)}`);
  }
  if (durationMs !== undefined && durationMs !== null) {
    parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  }
  return parts.join(" · ");
}

function scrollToBottom() {
  chatArea.scrollTop = chatArea.scrollHeight;
}

function generateId() {
  return "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}
