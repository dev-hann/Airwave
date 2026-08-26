/**
 * Receive-only WebSocket client for `/api/ws/events`.
 *
 * The server pushes full-state snapshots (see glossary: "Snapshot"); there
 * are no delta events and no client→server sends (the legacy send path was
 * dead code and was removed — ADR-0004). Reconnects with exponential
 * backoff (1s doubling, 10s cap), reset on successful open.
 */

import type { UiSnapshot } from "../../types/api";

type SnapshotHandler = (snapshot: UiSnapshot) => void;

const snapshotHandlers = new Set<SnapshotHandler>();

let wsClient: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 1000;
let started = false;

function websocketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/ws/events`;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(10000, reconnectDelayMs * 2);
}

function handleIncoming(raw: string): void {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // Malformed frame — nothing to do; next snapshot resyncs state.
  }
  if (
    payload !== null &&
    typeof payload === "object" &&
    (payload as { type?: unknown }).type === "snapshot"
  ) {
    const snapshot = payload as UiSnapshot;
    for (const handler of snapshotHandlers) {
      try {
        handler(snapshot);
      } catch {
        // Handler errors must not break other subscribers or the socket.
      }
    }
  }
}

function connect(): void {
  if (!started) return;
  if (wsClient) {
    wsClient.onopen = null;
    wsClient.onmessage = null;
    wsClient.onclose = null;
    wsClient.onerror = null;
    wsClient.close();
  }
  wsClient = new WebSocket(websocketUrl());
  wsClient.onopen = () => {
    reconnectDelayMs = 1000;
  };
  wsClient.onmessage = (event) => {
    if (typeof event.data === "string") handleIncoming(event.data);
  };
  wsClient.onerror = () => {
    try {
      wsClient?.close();
    } catch {
      // Ignore close errors on broken websocket state.
    }
  };
  wsClient.onclose = () => {
    scheduleReconnect();
  };
}

/** Connect the bus (idempotent). Call once at startup, after Pinia is active. */
export function connectWebsocket(): void {
  if (started) return;
  started = true;
  connect();
}

/** Subscribe to snapshots. Returns an unsubscribe function. */
export function onSnapshot(handler: SnapshotHandler): () => void {
  snapshotHandlers.add(handler);
  return () => snapshotHandlers.delete(handler);
}
