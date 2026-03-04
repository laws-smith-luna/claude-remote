/**
 * WebSocket client with auto-reconnect.
 */

class WS {
  constructor(token) {
    this.token = token;
    this.handlers = new Map();
    this.ws = null;
    this.reconnectDelay = 2000;
    this.maxReconnectDelay = 30000;
    this.currentDelay = this.reconnectDelay;
    this._closed = false;
    this.connect();
  }

  connect() {
    if (this._closed) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/ws?token=${encodeURIComponent(this.token)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log("[ws] Connected");
      this.currentDelay = this.reconnectDelay;
      const handler = this.handlers.get("_open");
      if (handler) handler();
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const handler = this.handlers.get(msg.type);
        if (handler) handler(msg);

        // Also fire wildcard handler
        const wildcard = this.handlers.get("*");
        if (wildcard) wildcard(msg);
      } catch (err) {
        console.error("[ws] Parse error:", err);
      }
    };

    this.ws.onclose = () => {
      console.log("[ws] Disconnected");
      const handler = this.handlers.get("_close");
      if (handler) handler();

      if (!this._closed) {
        setTimeout(() => this.connect(), this.currentDelay);
        this.currentDelay = Math.min(this.currentDelay * 1.5, this.maxReconnectDelay);
      }
    };

    this.ws.onerror = (err) => {
      console.error("[ws] Error:", err);
    };
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  on(type, handler) {
    this.handlers.set(type, handler);
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    this._closed = true;
    if (this.ws) this.ws.close();
  }
}

window.WS = WS;
