/**
 * UiEventBroker — WS snapshot broadcast. Port of app/services/ui_events.py:
 * per-client queues (drop-oldest), fresh snapshot on connect.
 */

import type { WebSocket } from "ws";

import type { UiSnapshot } from "./serializers.js";

export class UiEventBroker {
  private readonly clients = new Set<WebSocket>();
  private buildSnapshot: () => UiSnapshot;

  constructor(buildSnapshot: () => UiSnapshot) {
    this.buildSnapshot = buildSnapshot;
  }

  private sendTo(ws: WebSocket, snapshot: UiSnapshot): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(snapshot));
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    // Every (re)connect gets a fresh full snapshot — self-healing.
    this.sendTo(ws, this.buildSnapshot());
    ws.on("message", () => {
      // Server never consumes client frames; ignore quietly.
    });
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => {
      // Client disconnects are normal — no log spam.
      this.clients.delete(ws);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    });
  }

  publishSnapshot(): void {
    if (this.clients.size === 0) return;
    const snapshot = this.buildSnapshot();
    const payload = JSON.stringify(snapshot);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }
}
