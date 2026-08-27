/**
 * App version identity + deploy-drift detection.
 *
 * `__APP_VERSION__` is baked into the bundle at build time (root
 * package.json version — the single source of truth, same file the server
 * reads). A mismatch between bundle and server version means THIS BUNDLE IS
 * STALE — a tab left open across a deploy, still running old JS that may
 * silently ignore the current wire protocol (the v2.3.1 incident class).
 */
import { ref } from "vue";

import { getJson } from "./http";

/** Strip the leading "v" — CI tags carry one, package.json does not. */
export function normalizeVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  return version.startsWith("v") ? version.slice(1) : version;
}

/** What THIS tab is actually running — a cached bundle keeps its old value forever. */
export const bundleVersion =
  normalizeVersion(typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__) ?? "dev";

export const serverVersion = ref<string | null>(null);

export async function refreshServerVersion(): Promise<void> {
  try {
    const data = await getJson<{ version?: string }>("/api/system/version");
    serverVersion.value = normalizeVersion(data?.version ?? null);
  } catch {
    serverVersion.value = null;
  }
}

/** True when the bundle predates the running server — offer a reload. */
export function isVersionDrift(): boolean {
  const server = serverVersion.value;
  return server !== null && server !== bundleVersion;
}
