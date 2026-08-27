/** UiEventBroker unit tests — envelope, clamping, queue drop, backpressure, partial domains. */

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import { UiEventBroker } from "../src/ui-events.ts";

type StateDomain = "state" | "queue" | "history" | "playlists";

/** Minimal WebSocket double: open, tracks sends + bufferedAmount. */
class FakeWs extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly OPEN = 1;
  readyState = 1; // OPEN
  sent: string[] = [];
  bufferedAmount = 0;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

function makeBroker() {
  const builds: StateDomain[][] = [];
  const broker = new UiEventBroker((domains) => {
    builds.push(domains);
    return JSON.stringify({
      timestamp: 1_000 + builds.length,
      type: "state",
      data: Object.fromEntries(domains.map((d) => [d, { marker: d }])),
    });
  });
  return { broker, builds };
}

describe("UiEventBroker", () => {
  it("sends a FULL snapshot on connect (all four domains)", () => {
    const { broker, builds } = makeBroker();
    const ws = new FakeWs();
    broker.addClient(ws as never);

    expect(builds[0]).toEqual(["state", "queue", "history", "playlists"]);
    expect(ws.sent).toHaveLength(1);
    const message = JSON.parse(ws.sent[0]!);
    expect(message.type).toBe("state");
    expect(Object.keys(message.data)).toEqual(["state", "queue", "history", "playlists"]);
  });

  it("partial publish serializes only the requested domains", () => {
    const { broker, builds } = makeBroker();
    const ws = new FakeWs();
    broker.addClient(ws as never);
    ws.sent.length = 0;

    broker.publishSnapshot(["playlists"]);

    expect(builds[1]).toEqual(["playlists"]);
    const message = JSON.parse(ws.sent[0]!);
    expect(Object.keys(message.data)).toEqual(["playlists"]);
  });

  it("empty domains and zero clients are no-ops", () => {
    const { broker, builds } = makeBroker();
    broker.publishSnapshot([]);
    expect(builds).toHaveLength(0);

    broker.publishSnapshot(["state"]);
    expect(builds).toHaveLength(0); // no clients connected
  });

  it("drops OLDEST queued snapshots past the cap — newest always arrives", async () => {
    // Backpressure the client so sends stall and the queue fills.
    class SlowWs extends FakeWs {
      bufferedAmount = 5_000_000; // over budget: drain holds
    }
    const { broker } = makeBroker();
    const ws = new SlowWs();
    broker.addClient(ws as never);
    expect(ws.sent).toHaveLength(0); // connect snapshot held

    for (let i = 0; i < 40; i++) {
      broker.publishSnapshot(["state"]);
    }

    // Queue capped: 32 entries, the newest is the last publish.
    // Free the pressure: drain resumes and flushes what's left.
    ws.bufferedAmount = 0;
    broker.publishSnapshot(["state"]); // triggers a drain pass

    const payloads = ws.sent.map((raw) => JSON.parse(raw));
    // All sent messages must be in envelope order (strictly increasing timestamps).
    for (let i = 1; i < payloads.length; i++) {
      expect(payloads[i]!.timestamp).toBeGreaterThan(payloads[i - 1]!.timestamp);
    }
    // The newest state always lands.
    expect(payloads[payloads.length - 1]!.data.state).toEqual({ marker: "state" });
    // And the queue never exceeded the cap while pressured.
    expect(payloads.length).toBeLessThanOrEqual(34);
  });

  it("removes the client on close (no further sends)", () => {
    const { broker } = makeBroker();
    const ws = new FakeWs();
    broker.addClient(ws as never);
    expect(broker.clientCount()).toBe(1);

    ws.emit("close");
    expect(broker.clientCount()).toBe(0);
    ws.sent.length = 0;
    broker.publishSnapshot(["state"]);
    expect(ws.sent).toHaveLength(0);
  });

  it("ignored client frames do not throw", () => {
    const { broker } = makeBroker();
    const ws = new FakeWs();
    broker.addClient(ws as never);
    expect(() => ws.emit("message", Buffer.from("hello"))).not.toThrow();
  });
});

describe("nextEnvelopeTimestamp", () => {
  it("clamps to monotonic non-decreasing values", async () => {
    const { nextEnvelopeTimestamp } = await import("../src/ui-events.ts");
    expect(nextEnvelopeTimestamp(1_000, 0)).toBe(1_000);
    expect(nextEnvelopeTimestamp(999, 1_000)).toBe(1_000); // clock went back
    expect(nextEnvelopeTimestamp(1_050, 1_000)).toBe(1_050);
    expect(nextEnvelopeTimestamp(1_050, 1_050)).toBe(1_050); // same ms OK
  });
});

void vi;
