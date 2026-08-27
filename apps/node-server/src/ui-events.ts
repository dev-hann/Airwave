/**
 * UiEventBroker — WS state push with per-client queues.
 *
 * - Single message kind: `{timestamp(ms, monotonic-clamped), type:"state",
 *   data:{…domains}}`. Clients merge present keys and drop messages whose
 *   timestamp is strictly lower than the last applied one.
 * - Every client gets a fresh FULL snapshot on (re)connect — self-healing.
 * - Per-client outbound queue (cap: messages are state snapshots; dropping
 *   the OLDEST is always safe because a newer snapshot supersedes it).
 * - Backpressure guard: a client whose socket buffer exceeds the budget is
 *   skipped for that push (logged once per state) rather than disconnected.
 */

import type { WebSocket } from "ws";

interface ClientEntry {
  ws: WebSocket;
  queue: string[];
  /** True while the client exceeded the backpressure budget (log-once). */
  pressured: boolean;
}

export interface StatePushSource {
  /** Build the message (already serialized) for the given domains. */
  build: (domains: StateDomain[]) => string | null;
}

type StateDomain = "state" | "queue" | "history" | "playlists";

const QUEUE_CAP = 32;
/** ~1MB buffered: beyond this the client cannot keep up with full snapshots. */
const BUFFER_BUDGET_BYTES = 1_000_000;

export class UiEventBroker {
  private readonly clients = new Set<ClientEntry>();
  private readonly build: (domains: StateDomain[]) => string | null;
  private lastIssuedTimestamp = 0;

  constructor(buildMessage: (domains: StateDomain[]) => string | null) {
    this.build = buildMessage;
  }

  addClient(ws: WebSocket): void {
    const entry: ClientEntry = { ws, queue: [], pressured: false };
    this.clients.add(entry);
    // Every (re)connect gets a fresh full snapshot — self-healing.
    this.enqueue(entry, this.build(["state", "queue", "history", "playlists"]));
    this.drain(entry);
    ws.on("message", () => {
      // Server never consumes client frames; ignore quietly.
    });
    ws.on("close", () => this.clients.delete(entry));
    ws.on("error", () => {
      // Client disconnects are normal — no log spam.
      this.clients.delete(entry);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    });
  }

  /**
   * Publish a push for the given domains. Empty domains = no-op.
   * The message is built ONCE and shared across clients.
   */
  publishSnapshot(domains: StateDomain[] = ["state", "queue", "history", "playlists"]): void {
    if (domains.length === 0 || this.clients.size === 0) return;
    const payload = this.build(domains);
    if (payload === null) return;
    for (const entry of this.clients) {
      this.enqueue(entry, payload);
      this.drain(entry);
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  // ------------------------------------------------------------- internals

  private enqueue(entry: ClientEntry, payload: string | null): void {
    if (payload === null) return;
    entry.queue.push(payload);
    while (entry.queue.length > QUEUE_CAP) {
      // Oldest snapshot is superseded by anything newer — drop it.
      entry.queue.shift();
    }
  }

  private drain(entry: ClientEntry): void {
    const { ws } = entry;
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > BUFFER_BUDGET_BYTES) {
      if (!entry.pressured) {
        entry.pressured = true;
        console.warn(
          `[ui-events] client bufferedAmount=${ws.bufferedAmount} exceeds budget; holding pushes until it drains`,
        );
      }
      return;
    }
    if (entry.pressured && ws.bufferedAmount <= BUFFER_BUDGET_BYTES / 2) {
      entry.pressured = false;
    }
    while (entry.queue.length > 0 && ws.readyState === ws.OPEN) {
      if (ws.bufferedAmount > BUFFER_BUDGET_BYTES) break;
      const message = entry.queue.shift()!;
      ws.send(message);
    }
  }
}

/** Monotonic-clamped timestamp in ms — the envelope ordering key. */
export function nextEnvelopeTimestamp(nowMs: number, last: number): number {
  return Math.max(Math.trunc(nowMs), last);
}
