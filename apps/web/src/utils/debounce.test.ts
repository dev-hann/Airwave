import { afterEach, describe, expect, it, vi } from "vitest";

const { debounce } = await import("./debounce");

describe("debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays invocation until the wait elapses", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("collapses rapid calls into one invocation with the last args", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced(1);
    vi.advanceTimersByTime(25);
    debounced(2);
    vi.advanceTimersByTime(25);
    debounced(3);
    vi.advanceTimersByTime(50);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it("preserves argument types across calls", () => {
    vi.useFakeTimers();
    const fn = vi.fn((_a: string, _b: number) => {});
    const debounced = debounce(fn, 10);

    debounced("x", 1);
    vi.advanceTimersByTime(10);
    expect(fn).toHaveBeenCalledWith("x", 1);
  });
});
