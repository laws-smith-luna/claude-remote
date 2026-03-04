/**
 * MultiWS — manages one WebSocket per machine with independent reconnect.
 * Replaces the single WS class for the phone-as-hub architecture.
 *
 * Messages from servers are tagged with _machine (url) and _machineName
 * so handlers know which server they came from.
 */

import { flushOutgoing } from "./offline-store.js";

export class MultiWS {
  constructor() {
    this.connections = new Map(); // url -> { ws, machine, delay, closed, lastMessageTime, lastWatchedSession }
    this.handlers = new Map();   // type -> handler function
    this.reconnectDelay = 2000;
    this.maxReconnectDelay = 30000;
  }

  /** Connect to a machine */
  connectMachine(machine) {
    if (this.connections.has(machine.url)) {
      this.disconnectMachine(machine.url);
    }

    const state = {
      ws: null,
      machine,
      delay: this.reconnectDelay,
      closed: false,
      lastMessageTime: 0,
      lastWatchedSession: null,
    };
    this.connections.set(machine.url, state);
    this._connect(state);
  }

  /** Internal: establish WebSocket connection */
  _connect(state) {
    if (state.closed) return;

    const machine = state.machine;
    const wsUrl = machine.url.replace(/^http/, "ws");
    const url = `${wsUrl}/ws?token=${encodeURIComponent(machine.token)}`;

    try {
      state.ws = new WebSocket(url);
    } catch (err) {
      console.error(`[multi-ws] Failed to create WS for ${machine.name}:`, err);
      this._scheduleReconnect(state);
      return;
    }

    state.ws.onopen = () => {
      console.log(`[multi-ws] Connected to ${machine.name}`);
      state.delay = this.reconnectDelay;

      // Fire connection change
      this._fireHandler("_connection_change", {
        url: machine.url,
        name: machine.name,
        online: true,
      });

      // Request replay of missed messages
      if (state.lastWatchedSession && state.lastMessageTime > 0) {
        this.sendTo(machine.url, {
          type: "replay_request",
          sessionId: state.lastWatchedSession,
          since: state.lastMessageTime,
        });
      }

      // Flush queued outgoing messages
      flushOutgoing(machine.url, (msg) => {
        if (state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify(msg));
        }
      }).catch(() => { /* ignore flush errors */ });
    };

    state.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // Tag with machine info
        msg._machine = machine.url;
        msg._machineName = machine.name;

        // Track last message time for replay
        state.lastMessageTime = Date.now();

        // Track watched session
        if (msg.type === "live_entry" || msg.type === "live_status") {
          state.lastWatchedSession = msg.sessionId;
        }

        // Fire type-specific handler
        this._fireHandler(msg.type, msg);

        // Fire wildcard handler
        this._fireHandler("*", msg);
      } catch (err) {
        console.error(`[multi-ws] Parse error from ${machine.name}:`, err);
      }
    };

    state.ws.onclose = () => {
      console.log(`[multi-ws] Disconnected from ${machine.name}`);
      state.ws = null;

      this._fireHandler("_connection_change", {
        url: machine.url,
        name: machine.name,
        online: false,
      });

      if (!state.closed) {
        this._scheduleReconnect(state);
      }
    };

    state.ws.onerror = (err) => {
      console.error(`[multi-ws] Error for ${machine.name}:`, err);
    };
  }

  /** Schedule reconnect with exponential backoff */
  _scheduleReconnect(state) {
    setTimeout(() => this._connect(state), state.delay);
    state.delay = Math.min(state.delay * 1.5, this.maxReconnectDelay);
  }

  /** Disconnect from a specific machine */
  disconnectMachine(url) {
    const state = this.connections.get(url);
    if (state) {
      state.closed = true;
      if (state.ws) {
        try { state.ws.close(); } catch { /* ignore */ }
      }
      this.connections.delete(url);
    }
  }

  /** Disconnect from all machines */
  disconnectAll() {
    for (const url of [...this.connections.keys()]) {
      this.disconnectMachine(url);
    }
  }

  /** Send a message to a specific machine by URL */
  sendTo(machineUrl, msg) {
    const state = this.connections.get(machineUrl);
    if (state?.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Send to the first connected machine (fallback) */
  sendToAny(msg) {
    for (const state of this.connections.values()) {
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(msg));
        return true;
      }
    }
    return false;
  }

  /** Register an event handler (same API as old WS class) */
  on(type, handler) {
    this.handlers.set(type, handler);
  }

  /** Fire a handler if registered */
  _fireHandler(type, msg) {
    const handler = this.handlers.get(type);
    if (handler) handler(msg);
  }

  /** True if any machine WS is open */
  get anyConnected() {
    for (const state of this.connections.values()) {
      if (state.ws?.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  /** Get connection status per machine */
  getStatus() {
    const status = [];
    for (const [url, state] of this.connections) {
      status.push({
        url,
        name: state.machine.name,
        online: state.ws?.readyState === WebSocket.OPEN,
      });
    }
    return status;
  }

  /** Check if a specific machine is connected */
  isConnected(machineUrl) {
    const state = this.connections.get(machineUrl);
    return state?.ws?.readyState === WebSocket.OPEN;
  }
}

// Keep old WS class available for backward compat (unused by new code)
window.MultiWS = MultiWS;
