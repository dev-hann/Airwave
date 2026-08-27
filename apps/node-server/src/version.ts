/**
 * App version resolution — package.json is the single source of truth.
 *
 * The ROOT workspace package.json version is read by BOTH sides:
 *  - server: this module (served via GET /api/system/version)
 *  - web bundle: vite `define __APP_VERSION__` in apps/web/vite.config.ts
 *
 * Both values come from the same build, so a bundle/server mismatch always
 * means a stale browser tab (the v2.3.1 incident class). The env var is a
 * fallback for images that somehow lack the file — package.json WINS over
 * env so branch builds (env "dev-<sha>") never fake a drift.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rootPackageJson = join(here, "../../../package.json");

export function resolveAppVersion(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const pkg = JSON.parse(readFileSync(rootPackageJson, "utf8")) as { version?: string };
    if (pkg.version && pkg.version.length > 0) return pkg.version;
  } catch {
    // Missing/unreadable package.json — fall back to env below.
  }
  return env.AIRWAVE_APP_VERSION ?? "dev";
}
