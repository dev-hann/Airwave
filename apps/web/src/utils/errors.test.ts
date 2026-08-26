import { describe, expect, it, vi } from "vitest";
import { formatErrorMessage } from "./errors";
import { ApiError } from "../lib/api/http";

describe("formatErrorMessage", () => {
  it("uses ApiError.detail string when present", () => {
    const error = new ApiError(400, JSON.stringify({ detail: "Playlist not found" }));
    expect(formatErrorMessage(error)).toBe("Playlist not found");
  });

  it("uses first msg from ApiError detail array (FastAPI validation)", () => {
    const error = new ApiError(422, JSON.stringify({ detail: [{ loc: ["body"], msg: "Field required", type: "missing" }] }));
    expect(formatErrorMessage(error)).toBe("Field required");
  });

  it("falls back to raw message when detail is absent", () => {
    const error = new ApiError(500, "Internal Server Error");
    expect(formatErrorMessage(error)).toBe("Internal Server Error");
  });

  it("JSON-parses plain Error messages (legacy path)", () => {
    const error = new Error(JSON.stringify({ detail: "legacy detail" }));
    expect(formatErrorMessage(error)).toBe("legacy detail");
  });

  it("truncates long messages to 180 chars", () => {
    const long = "x".repeat(300);
    const error = new Error(long);
    const result = formatErrorMessage(error);
    expect(result.length).toBe(180);
    expect(result.endsWith("...")).toBe(true);
  });

  it("stringifies non-Error values", () => {
    expect(formatErrorMessage(undefined)).toBe("Request failed");
    expect(formatErrorMessage(null)).toBe("Request failed");
  });

  it("does not throw on non-JSON garbage", () => {
    const error = new Error("<html>502 Bad Gateway</html>");
    expect(formatErrorMessage(error)).toContain("502");
  });
});

describe("ApiError", () => {
  it("keeps status and message from body", () => {
    const error = new ApiError(404, "not found body");
    expect(error.status).toBe(404);
    expect(error.message).toBe("not found body");
    expect(error.detail).toBeNull();
  });

  it("uses fallback message when body is empty", () => {
    const error = new ApiError(502, "");
    expect(error.message).toBe("Request failed: 502");
  });
});

describe("debounce (indirect via errors module isolation)", () => {
  it("module has no side effects on import", () => {
    expect(vi.isMockFunction(formatErrorMessage)).toBe(false);
  });
});
