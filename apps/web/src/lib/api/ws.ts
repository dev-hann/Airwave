/**
 * Receive-only WebSocket client for `/api/ws/events`.
 *
 * The server pushes state messages under the shared envelope
 * `{timestamp(ms, monotonic), type:"state", data:{…domains}}` — validated
 * here with the zod contract (packages/shared/contracts.ts), which BOTH
 * sides import. Messages with a timestamp strictly lower than the last
 * applied one are dropped (stale snapshots must never clobber newer
 * state). No client→server sends (ADR-0004). Reconnects with exponential
 * backoff (1s doubling, 10s cap), reset on successful open; the server
 * answers every (re)connect with a fresh FULL snapshot, so recovery is
 * automatic. Connection status is surfaced for UI indicators.
 */

import { WsMessageSchema, type WsMessagePayload } from "@airwave/shared/contracts";
import { ref } from "vue";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

type MessageHandler = (message: WsMessagePayload) => void;

const messageHandlers = new Set<MessageHandler>();

/** Reactive connection status for badges/indicators. */
export const connectionState = ref<ConnectionState>("disconnected");

let wsClient: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 1000;
let started = false;
let lastAppliedTimestamp = 0;
let parseWarned = false;

function websocketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/ws/events`;
}

function scheduleReconnect(): void {
  connectionState.value = started ? "reconnecting" : "disconnected";
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
    return; // Malformed frame — nothing to do; the next snapshot resyncs.
  }
  const parsed = WsMessageSchema.safeParse(payload);
  if (!parsed.success) {
    if (!parseWarned) {
      parseWarned = true;
      console.warn("[ws] message failed contract validation; ignoring", parsed.error.issues[0]);
    }
    return;
  }
  const message = parsed.data;
  // Staleness guard: strictly older snapshots are superseded; equal is OK
  // (idempotent full snapshots).
  if (message.timestamp < lastAppliedTimestamp) return;
  lastAppliedTimestamp = message.timestamp;
  for (const handler of messageHandlers) {
    try {
      handler(message);
    } catch {
      // Handler errors must not break other subscribers or the socket.
    }
  }
}

function connect(): void {
  if (!started) return;
  connectionState.value = "connecting";
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
    connectionState.value = "connected";
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

/** Subscribe to validated state messages. Returns an unsubscribe function. */
export function onStateMessage(handler: MessageHandler): () => void {
  messageHandlers.add(handler);
  return () => messageHandlers.delete(handler);
}
