import type { AgentEvent, ClientMessage } from "../types/agent";

type EventHandler = (event: AgentEvent) => void;

/** Thin auto-reconnecting WebSocket wrapper for the harness protocol. */
export class HarnessSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<EventHandler>();
  private queue: ClientMessage[] = [];
  private reconnectTimer: number | null = null;

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      for (const msg of this.queue.splice(0)) this.send(msg);
      this.send({ type: "terminal.start" });
    };
    this.ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        for (const h of this.handlers) h(event);
      } catch {
        /* ignore malformed frames */
      }
    };
    this.ws.onclose = () => {
      this.reconnectTimer = window.setTimeout(() => this.connect(), 1500);
    };
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
      this.connect();
    }
  }

  dispose() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

export const harnessSocket = new HarnessSocket();
