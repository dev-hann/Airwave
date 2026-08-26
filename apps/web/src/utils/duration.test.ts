import { describe, expect, it } from "vitest";

import { formatDuration, formatTotalDuration } from "./duration";

describe("formatDuration", () => {
  it("formats seconds as mm:ss", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(5)).toBe("00:05");
    expect(formatDuration(65)).toBe("01:05");
    expect(formatDuration(599)).toBe("09:59");
  });

  it("formats hours as hh:mm:ss", () => {
    expect(formatDuration(3600)).toBe("01:00:00");
    expect(formatDuration(3661)).toBe("01:01:01");
  });

  it("pads minutes and seconds", () => {
    expect(formatDuration(600)).toBe("10:00");
    expect(formatDuration(601)).toBe("10:01");
  });

  it("clamps negative and invalid input to 00:00", () => {
    expect(formatDuration(-10)).toBe("00:00");
    expect(formatDuration(null)).toBe("00:00");
    expect(formatDuration(undefined)).toBe("00:00");
    expect(formatDuration(Number.NaN)).toBe("00:00");
  });

  it("floors fractional seconds", () => {
    expect(formatDuration(59.9)).toBe("00:59");
  });
});

describe("formatTotalDuration", () => {
  it("shows < 1 min for short durations", () => {
    expect(formatTotalDuration(0)).toBe("< 1 min");
    expect(formatTotalDuration(59)).toBe("< 1 min");
  });

  it("shows minutes only below an hour", () => {
    expect(formatTotalDuration(60)).toBe("1 min");
    expect(formatTotalDuration(3599)).toBe("59 min");
  });

  it("shows hr + min above an hour", () => {
    expect(formatTotalDuration(3600)).toBe("1 hr 0 min");
    expect(formatTotalDuration(3660)).toBe("1 hr 1 min");
    expect(formatTotalDuration(7325)).toBe("2 hr 2 min");
  });

  it("clamps invalid input", () => {
    expect(formatTotalDuration(-100)).toBe("< 1 min");
    expect(formatTotalDuration(null)).toBe("< 1 min");
  });
});
