/**
 * ws.ts bus tests: zod frame validation, staleness guard, and connection
 * state transitions — using a fake WebSocket transport injected via
 * __setWebSocketFactoryForTests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetForTests,
  __setWebSocketFactoryForTests,
  connectWebsocket,
  connectionState,
  onStateMessage,
} from "./ws";
import type { WsMessagePayload } from "@airwave/shared/contracts";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static get last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.length - 1]!;
  }
  static get length(): number {
    return FakeWebSocket.instances.length;
  }

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  message(data: string): void {
    this.onmessage?.({ data });
  }

  closeEvent(): void {
    this.onclose?.();
  }
}

const FULL_STATE = {
  mode: "playing",
  paused: false,
  repeat_mode: "off",
  shuffle_enabled: false,
  can_seek: false,
  now_playing_id: null,
  now_playing_title: null,
  now_playing_channel: null,
  now_playing_thumbnail_url: null,
  now_playing_is_live: false,
  now_playing_is_liked: false,
  stream_url: "/stream/live.m3u8",
  duration_seconds: null,
  started_at: null,
  elapsed_seconds: null,
  progress_percent: null,
};

function validMessage(stateOverrides: Record<string, unknown> = {}, timestamp = 1000): string {
  return JSON.stringify({
    timestamp,
    type: "state",
    data: { state: { ...FULL_STATE, ...stateOverrides } },
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  __resetForTests();
  __setWebSocketFactoryForTests((url) => new FakeWebSocket(url) as unknown as WebSocket);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ws bus", () => {
  it("connects, transitions to connected, and delivers a valid message to handlers", async () => {
    const received: WsMessagePayload[] = [];
    onStateMessage((m) => received.push(m));

    connectWebsocket();
    expect(connectionState.value).toBe("connecting");
    expect(FakeWebSocket.length).toBe(1);

    FakeWebSocket.last.open();
    expect(connectionState.value).toBe("connected");

    FakeWebSocket.last.message(validMessage());
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("state");
    expect(received[0]!.data.state?.mode).toBe("playing");
  });

  it("drops malformed JSON without notifying handlers", () => {
    const received: WsMessagePayload[] = [];
    onStateMessage((m) => received.push(m));
    connectWebsocket();
    FakeWebSocket.last.open();

    FakeWebSocket.last.message("{not json");
    FakeWebSocket.last.message("null");

    expect(received).toHaveLength(0);
  });

  it("drops frames that fail the zod contract (string timestamp, wrong type, missing data)", () => {
    const received: WsMessagePayload[] = [];
    onStateMessage((m) => received.push(m));
    connectWebsocket();
    FakeWebSocket.last.open();

    FakeWebSocket.last.message(JSON.stringify({ timestamp: "1000", type: "state", data: {} }));
    FakeWebSocket.last.message(JSON.stringify({ timestamp: 1000, type: "snapshot", data: {} }));
    FakeWebSocket.last.message(JSON.stringify({ timestamp: 1000, type: "state" }));
    FakeWebSocket.last.message(JSON.stringify({ timestamp: 1000, type: "state", data: { queue: "not-an-array" } }));

    expect(received).toHaveLength(0);
    expect(console.warn).toHaveBeenCalled();
  });

  it("staleness guard: strictly older is dropped, equal is applied", () => {
    const received: WsMessagePayload[] = [];
    onStateMessage((m) => received.push(m));
    connectWebsocket();
    FakeWebSocket.last.open();

    FakeWebSocket.last.message(validMessage({}, 1000));
    FakeWebSocket.last.message(validMessage({}, 900)); // older → dropped
    FakeWebSocket.last.message(validMessage({}, 1000)); // equal → applied
    FakeWebSocket.last.message(validMessage({}, 1100)); // newer → applied

    expect(received).toHaveLength(3);
  });

  it("close transitions to reconnecting and schedules exactly one retry", () => {
    vi.useFakeTimers();
    try {
      connectWebsocket();
      FakeWebSocket.last.open();
      FakeWebSocket.last.closeEvent();

      // Close → exactly ONE retry per backoff slot (no busy-reconnect).
      vi.advanceTimersByTime(1000);
      expect(FakeWebSocket.length).toBe(2);

      FakeWebSocket.last.open();
      FakeWebSocket.last.closeEvent();
      // Doubled backoff (2s): flushing a full window yields exactly one more.
      vi.advanceTimersByTime(2000);
      expect(FakeWebSocket.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reconnect delivers fresh messages again (timestamp resets are tolerated)", () => {
    const received: WsMessagePayload[] = [];
    onStateMessage((m) => received.push(m));
    connectWebsocket();
    FakeWebSocket.last.open();
    FakeWebSocket.last.message(validMessage({}, 5000));
    expect(received).toHaveLength(1);

    // Server restart: new process, timestamps restart low. __resetForTests
    // models a fresh page load, which is the actual recovery path.
    __resetForTests();
    FakeWebSocket.instances = [];
    connectWebsocket();
    FakeWebSocket.last.open();
    FakeWebSocket.last.message(validMessage({}, 100));
    expect(received).toHaveLength(2);
  });
});
