import { ApiError } from "../lib/api/http";

function shapeDetail(detail: unknown, fallback: string): string {
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0] as { msg?: unknown } | undefined;
    if (first && typeof first.msg === "string") return first.msg;
    return fallback;
  }
  if (typeof detail === "string" && detail) return detail;
  return fallback;
}

/**
 * Human-readable message from an API error. Understands FastAPI `detail`
 * payloads (string or array-of-msg forms) via `ApiError.detail`, with a
 * JSON-parse fallback for errors raised before `ApiError` existed.
 */
export function formatErrorMessage(error: unknown): string {
  const fallback = error instanceof Error ? error.message : String(error || "Request failed");
  if (error instanceof ApiError && error.detail !== null) {
    const shaped = shapeDetail(error.detail, fallback);
    return shaped.length > 180 ? `${shaped.slice(0, 177)}...` : shaped;
  }
  try {
    const parsed = JSON.parse(fallback) as { detail?: unknown } | null;
    if (parsed && typeof parsed === "object" && "detail" in parsed) {
      const shaped = shapeDetail(parsed.detail, fallback);
      if (shaped !== fallback) {
        return shaped.length > 180 ? `${shaped.slice(0, 177)}...` : shaped;
      }
    }
  } catch {
    // Keep the original message when the payload is not JSON.
  }
  return fallback.length > 180 ? `${fallback.slice(0, 177)}...` : fallback;
}
