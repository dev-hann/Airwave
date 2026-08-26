/**
 * Typed HTTP client. Same-origin relative URLs (`/api/...`) only.
 * All API calls go through here (see docs/frontend/conventions.md).
 */

export class ApiError extends Error {
  readonly status: number;
  /** Parsed FastAPI `detail` field when the body was JSON, else `null`. */
  readonly detail: unknown;

  constructor(status: number, bodyText: string) {
    super(bodyText || `Request failed: ${status}`);
    this.name = "ApiError";
    this.status = status;
    try {
      const parsed = JSON.parse(bodyText) as { detail?: unknown };
      this.detail = parsed && typeof parsed === "object" && "detail" in parsed ? parsed.detail : null;
    } catch {
      this.detail = null;
    }
  }
}

/**
 * Fetch with JSON handling. Behavior:
 * - non-ok → throws `ApiError` (message = raw body text, matching the legacy client)
 * - 204 → `null`
 * - JSON content-type → parsed body
 * - text body that parses as JSON → parsed; otherwise the raw string
 */
export async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const detail = await response.text();
    throw new ApiError(response.status, detail);
  }
  // Some endpoints intentionally return 204 No Content (e.g. DELETE).
  if (response.status === 204) return null as T;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return (await response.json()) as T;
  const text = await response.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** POST with a JSON body — the standard request shape for this API. */
export function postJson<T>(url: string, body?: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** PATCH with a JSON body. */
export function patchJson<T>(url: string, body?: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** DELETE returning the (usually empty) body as `T`. */
export function deleteJson<T>(url: string): Promise<T> {
  return fetchJson<T>(url, { method: "DELETE" });
}

/** GET with query parameters. */
export function getJson<T>(url: string, query?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  if (!query) return fetchJson<T>(url);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return fetchJson<T>(qs ? `${url}?${qs}` : url);
}
