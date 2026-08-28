/**
 * BinariesService — inspect/update the bundled runtime tools
 * (yt-dlp, ffmpeg, ffprobe, deno). Port of app/services/binaries_service.py.
 *
 * Rules honored: list-argv spawn only, bounded network timeouts, atomic
 * replaces via a `.new` sibling + rename. Managed = lives under <cwd>/bin.
 */

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";

const YT_DLP_RELEASES_URL = "https://api.github.com/repos/yt-dlp/yt-dlp/releases";
const FFMPEG_RELEASES_URL = "https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases";
const DENO_RELEASES_URL = "https://api.github.com/repos/denoland/deno/releases";
const MARTIN_RIEDL_FFMPEG_INDEX_URL = "https://ffmpeg.martin-riedl.de/";
const GITHUB_UA = "Airwave/2.0 (https://github.com/dev-hann/Airwave)";

export interface BinaryStatus {
  name: string;
  path: string;
  version: string;
  is_system: boolean;
  link: string | null;
}

export interface BinaryUpdateInfo {
  name: string;
  current: string;
  latest: string;
  has_update: boolean;
}

export type InstallFailureKind =
  | "unknown-binary"
  | "unsupported-platform"
  | "system-binary"
  | "no-release"
  | "extract"
  | "extract-tool-missing"
  | "busy"
  | "network";

export class BinariesInstallError extends Error {
  readonly kind: InstallFailureKind;
  constructor(kind: InstallFailureKind, message: string) {
    super(message);
    this.name = "BinariesInstallError";
    this.kind = kind;
  }
}

interface GithubRelease {
  tag_name?: string;
  prerelease?: boolean;
  published_at?: string;
}

function moduleRoot(): string {
  // <repo>/apps/node-server/src/binaries-service.ts → <repo>
  return resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function managedBinDir(): string {
  // Docker: cwd is /app and binaries live in /app/bin. Repo: process cwd may
  // be apps/node-server, so also honor the module-root bin/.
  return join(process.cwd(), "bin");
}

function platformPair(): { system: string; machine: string } {
  return { system: process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform, machine: process.arch };
}

async function fetchJson<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": GITHUB_UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return (await response.json()) as T;
}

async function fetchText(url: string, timeoutMs = 30_000): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": GITHUB_UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return await response.text();
}

function resolveToolPath(configured: string): string {
  if (!configured.includes("/") && !configured.includes("\\")) {
    // Bare name: look in the managed bin dir first (Docker PATH setup), then PATH.
    const managed = join(managedBinDir(), configured);
    if (existsSync(managed)) return managed;
    const moduleBin = join(moduleRoot(), "bin", configured);
    if (existsSync(moduleBin)) return moduleBin;
    return configured;
  }
  const expanded = configured.startsWith("~") ? resolvePath(configured.replace(/^~/, process.env.HOME ?? "~")) : configured;
  if (!isAbsolute(expanded)) return resolvePath(process.cwd(), expanded);
  return resolvePath(expanded);
}

function isManagedPath(resolvedPath: string): boolean {
  const roots = [managedBinDir(), join(moduleRoot(), "bin")];
  for (const root of roots) {
    const abs = resolvePath(root);
    if (resolvedPath === abs || resolvedPath.startsWith(abs + "/")) return true;
  }
  return false;
}

function runCapture(cmd: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.once("error", () => {
      clearTimeout(timer);
      resolvePromise(null);
    });
    proc.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise(code === 0 ? stdout.trim() : null);
    });
  });
}

function parseYtDlpVersion(out: string): string {
  return out.split("\n")[0]?.trim() ?? "";
}

function parseFfmpegVersion(out: string): string {
  const match = /ffmpeg version (\S+)/.exec(out ?? "");
  if (!match) return "";
  const token = match[1] ?? "";
  const date = /(\d{8})/.exec(token);
  if (date) {
    const raw = date[1] ?? "";
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return token;
}

function stripFfprobeUrlSuffix(token: string): string {
  const index = token.toLowerCase().indexOf("-http");
  return index > 0 ? token.slice(0, index) : token;
}

function parseFfprobeVersion(out: string): string {
  const match = /ffprobe version (\S+)/.exec(out ?? "");
  if (!match) return "";
  return stripFfprobeUrlSuffix(match[1] ?? "");
}

function parseDenoVersion(out: string): string {
  const match = /deno (\d+\.\d+\.\d+)/.exec(out ?? "");
  if (match) return match[1] ?? "";
  return out.split("\n")[0]?.trim() ?? "";
}

function compareNumericVersions(latest: string, current: string): boolean {
  const parse = (value: string): number[] => value.split(".").map((part) => Number.parseInt(part, 10));
  if (!latest.split(".").every((part) => /^\d+$/.test(part))) return false;
  if (!current.split(".").every((part) => /^\d+$/.test(part))) return false;
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

function ytDlpAssetName(): string | null {
  const { system, machine } = platformPair();
  if (system === "linux") return machine === "x64" ? "yt-dlp_linux" : machine === "arm64" ? "yt-dlp_linux_aarch64" : null;
  if (system === "darwin") return "yt-dlp_macos";
  return null;
}

function denoAssetName(): string | null {
  const { system, machine } = platformPair();
  if (system === "linux") {
    if (machine === "x64") return "deno-x86_64-unknown-linux-gnu.zip";
    if (machine === "arm64") return "deno-aarch64-unknown-linux-gnu.zip";
    return null;
  }
  if (system === "darwin") {
    if (machine === "x64") return "deno-x86_64-apple-darwin.zip";
    if (machine === "arm64") return "deno-aarch64-apple-darwin.zip";
    return null;
  }
  return null;
}

function ffmpegAssetName(): string | null {
  const { system, machine } = platformPair();
  if (system === "linux") {
    if (machine === "x64") return "ffmpeg-master-latest-linux64-gpl.tar.xz";
    if (machine === "arm64") return "ffmpeg-master-latest-linuxarm64-gpl.tar.xz";
    return null;
  }
  if (system === "darwin") {
    if (machine === "x64") return "ffmpeg-master-latest-macos64-gpl.zip";
    if (machine === "arm64") return "ffmpeg-master-latest-macosarm64-gpl.zip";
    return null;
  }
  return null;
}

function martinRiedlPlatformHeading(): string | null {
  const { system, machine } = platformPair();
  if (system === "linux") return machine === "x64" ? "Linux (amd64)" : machine === "arm64" ? "Linux (arm64v8)" : null;
  if (system === "darwin") return machine === "x64" ? "macOS (Intel/amd64)" : machine === "arm64" ? "macOS (Apple Silicon/arm64)" : null;
  return null;
}

function martinRiedlReleaseSection(html: string): string | null {
  const start = html.indexOf("<h2>Download Release Build</h2>");
  if (start < 0) return null;
  const end = html.indexOf("<h2>Timeline", start);
  return end < 0 ? html.slice(start) : html.slice(start, end);
}

function htmlSubsectionAfterH3(html: string, heading: string): string | null {
  const needle = `<h3>${heading}</h3>`;
  const position = html.indexOf(needle);
  if (position < 0) return null;
  const rest = html.slice(position + needle.length);
  const next = rest.indexOf("<h3>");
  return next >= 0 ? rest.slice(0, next) : rest;
}

function martinRiedlReleaseVersion(subsection: string): string | null {
  const label = /<p>\s*<b>\s*Release:\s*<\/b>\s*([^<]+?)\s*<\/p>/i.exec(subsection);
  if (label?.[1]) return label[1];
  const url = /(?:https:\/\/ffmpeg\.martin-riedl\.de)?\/download\/[^"\s]+\/(\d+_[\d.]+)\/ffprobe\.zip/.exec(subsection);
  return url?.[1] ?? null;
}

function martinRiedlOsArchSlugs(): { os: string; arch: string } | null {
  const { system, machine } = platformPair();
  const os = system === "linux" ? "linux" : system === "darwin" ? "macos" : null;
  if (!os) return null;
  if (machine === "x64") return { os, arch: "amd64" };
  if (machine === "arm64") return { os, arch: "arm64" };
  return null;
}

// ------------------------------------------------------------------ zip

/**
 * Minimal ZIP extractor for the single-binary archives we install (deno,
 * ffprobe). Central-directory driven; supports STORE + DEFLATE entries.
 */
async function extractZip(archivePath: string, destDir: string): Promise<string[]> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const buffer = await readFile(archivePath);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Locate End of Central Directory (scan back — comment can be up to 64K).
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 66_000); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const extracted: string[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error(`zip: bad central directory entry ${index}`);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    if (!name.endsWith("/")) {
      // Local header: the extra-field length can differ from the central one.
      if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
      const localNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

      let content: Buffer;
      if (method === 0) content = Buffer.from(compressed);
      else if (method === 8) content = inflateRawSync(compressed);
      else throw new Error(`zip: unsupported compression method ${method} for ${name}`);

      // Sanitize entry names (no absolute paths / traversal).
      const safeName = name.replace(/\\/g, "/").split("/").filter((part) => part && part !== "..").join("/");
      if (!safeName) continue;
      const target = join(destDir, safeName);
      mkdirSync(dirname(target), { recursive: true });
      await writeFile(target, content);
      extracted.push(target);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return extracted;
}

/** Extract a .tar.xz via the system tar (Docker runtime ships xz-utils). */
async function extractTarXz(archivePath: string, destDir: string): Promise<void> {
  const code = await new Promise<number | Error>((resolvePromise) => {
    const proc = spawn("tar", ["-xJf", archivePath, "-C", destDir], { stdio: "ignore" });
    proc.once("error", (error) => resolvePromise(error));
    proc.once("close", (exitCode) => resolvePromise(exitCode ?? 0));
  });
  if (code instanceof Error) throw new BinariesInstallError("extract-tool-missing", `tar unavailable: ${code.message}`);
  if (code !== 0) throw new BinariesInstallError("extract", `tar exited with status ${code}`);
}

function findBinaryRecursive(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findBinaryRecursive(full, name);
      if (found) return found;
    } else if (entry.name === name && statSync(full).isFile()) {
      return full;
    }
  }
  return null;
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": GITHUB_UA },
    redirect: "follow",
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok || !response.body) throw new BinariesInstallError("network", `download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(destPath));
}

function mapInstallError(error: unknown): BinariesInstallError {
  if (error instanceof BinariesInstallError) return error;
  const code = (error as { code?: string })?.code;
  if (code === "ETXTBSY" || code === "EBUSY") return new BinariesInstallError("busy", "binary_in_use");
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch|network|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(message)) return new BinariesInstallError("network", message);
  return new BinariesInstallError("extract", message);
}

/** Atomic replace: copy → chmod → rename over the target. */
function installBinaryFile(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const staged = `${target}.new`;
  copyFileSync(source, staged);
  chmodSync(staged, 0o755);
  try {
    renameSync(staged, target);
  } catch (error) {
    rmSync(staged, { force: true });
    throw mapInstallError(error);
  }
}

export interface BinariesServiceOptions {
  ytDlpPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  denoPath: string;
}

interface ToolSpec {
  name: string;
  configured: string;
  versionArgs: string[];
  parseVersion: (out: string) => string;
  link: string;
}

export class BinariesService {
  private readonly tools: ToolSpec[];

  constructor(options: BinariesServiceOptions) {
    this.tools = [
      { name: "yt-dlp", configured: options.ytDlpPath, versionArgs: ["--version"], parseVersion: parseYtDlpVersion, link: "https://github.com/yt-dlp/yt-dlp/releases" },
      { name: "ffmpeg", configured: options.ffmpegPath, versionArgs: ["-version"], parseVersion: parseFfmpegVersion, link: "https://github.com/yt-dlp/FFmpeg-Builds/releases" },
      { name: "ffprobe", configured: options.ffprobePath, versionArgs: ["-version"], parseVersion: parseFfprobeVersion, link: MARTIN_RIEDL_FFMPEG_INDEX_URL },
      { name: "deno", configured: options.denoPath, versionArgs: ["--version"], parseVersion: parseDenoVersion, link: "https://github.com/denoland/deno/releases" },
    ];
  }

  async getBinaries(): Promise<BinaryStatus[]> {
    const result: BinaryStatus[] = [];
    for (const tool of this.tools) {
      const path = resolveToolPath(tool.configured);
      const isSystem = !isManagedPath(path);
      let version = "";
      if (path) {
        const out = await runCapture(path, tool.versionArgs);
        version = out ? tool.parseVersion(out) : "";
      }
      result.push({ name: tool.name, path: path || tool.configured, version, is_system: isSystem, link: tool.link });
    }
    return result;
  }

  async getUpdates(): Promise<BinaryUpdateInfo[]> {
    const byName = new Map((await this.getBinaries()).map((binary) => [binary.name, binary]));
    const result: BinaryUpdateInfo[] = [];

    const ytDlp = byName.get("yt-dlp");
    const latestYtDlp = await this.latestYtDlp();
    if (latestYtDlp) {
      const current = ytDlp?.version ?? "";
      const hasUpdate = (!current && !(ytDlp?.is_system ?? true)) || (current.length > 0 && !(ytDlp?.is_system ?? true) && compareNumericVersions(latestYtDlp, current));
      result.push({ name: "yt-dlp", current: current || "—", latest: latestYtDlp, has_update: hasUpdate });
    }

    const ffmpeg = byName.get("ffmpeg");
    const latestFfmpeg = await this.latestFfmpeg();
    if (ffmpeg) {
      if (latestFfmpeg && !ffmpeg.is_system) {
        result.push({ name: "ffmpeg", current: ffmpeg.version || "—", latest: latestFfmpeg, has_update: ffmpeg.version !== latestFfmpeg });
      } else {
        result.push({ name: "ffmpeg", current: ffmpeg.version || "—", latest: latestFfmpeg || "—", has_update: false });
      }
    }

    const ffprobe = byName.get("ffprobe");
    if (ffprobe) {
      const latestMr = await this.latestMartinRiedlFfprobe();
      const current = (ffprobe.version || "").trim();
      const hasUpdate = latestMr && !ffprobe.is_system ? (!current || compareNumericVersions(latestMr, current)) : false;
      result.push({ name: "ffprobe", current: current || "—", latest: latestMr || "—", has_update: hasUpdate });
    }

    const deno = byName.get("deno");
    const latestDeno = await this.latestDeno();
    if (latestDeno) {
      const current = deno?.version ?? "";
      const hasUpdate = (!current && !(deno?.is_system ?? true)) || (current.length > 0 && !(deno?.is_system ?? true) && compareNumericVersions(latestDeno, current));
      result.push({ name: "deno", current: current || "—", latest: latestDeno, has_update: hasUpdate });
    }

    return result;
  }

  async install(name: string): Promise<void> {
    try {
      if (name === "yt-dlp") await this.installYtDlp();
      else if (name === "ffmpeg") await this.installFfmpeg();
      else if (name === "ffprobe") await this.installFfprobe();
      else if (name === "deno") await this.installDeno();
      else throw new BinariesInstallError("unknown-binary", `Unknown binary: ${name}`);
    } catch (error) {
      throw mapInstallError(error);
    }
  }

  private async latestYtDlp(): Promise<string | null> {
    try {
      const releases = await fetchJson<GithubRelease[]>(`${YT_DLP_RELEASES_URL}?per_page=5`);
      for (const release of releases) {
        if (release.prerelease) continue;
        const tag = release.tag_name ?? "";
        if (/^\d{4}\.\d{2}\.\d{2}$/.test(tag)) return tag;
      }
    } catch {
      // Offline / rate-limited: report no latest rather than failing the route.
    }
    return null;
  }

  private async latestFfmpeg(): Promise<string | null> {
    try {
      const releases = await fetchJson<GithubRelease[]>(`${FFMPEG_RELEASES_URL}?per_page=5`);
      for (const release of releases) {
        if (release.tag_name === "latest") {
          const published = release.published_at ?? "";
          return published ? published.slice(0, 10) : "latest";
        }
      }
    } catch {
      // See latestYtDlp().
    }
    return null;
  }

  private async latestDeno(): Promise<string | null> {
    try {
      const releases = await fetchJson<GithubRelease[]>(`${DENO_RELEASES_URL}?per_page=5`);
      for (const release of releases) {
        if (release.prerelease) continue;
        const tag = release.tag_name ?? "";
        if (tag.startsWith("v") && /^v\d+\.\d+\.\d+/.test(tag)) return tag.replace(/^v/, "");
      }
    } catch {
      // See latestYtDlp().
    }
    return null;
  }

  private async latestMartinRiedlFfprobe(): Promise<string | null> {
    const heading = martinRiedlPlatformHeading();
    if (!heading) return null;
    try {
      const html = await fetchText(MARTIN_RIEDL_FFMPEG_INDEX_URL);
      const release = martinRiedlReleaseSection(html);
      if (!release) return null;
      const block = htmlSubsectionAfterH3(release, heading);
      if (!block) return null;
      return martinRiedlReleaseVersion(block);
    } catch {
      return null;
    }
  }

  private requireManaged(name: string, target: string): void {
    if (!isManagedPath(target)) throw new BinariesInstallError("system-binary", `Cannot update system-installed ${name}`);
  }

  private async installYtDlp(): Promise<void> {
    const asset = ytDlpAssetName();
    if (!asset) throw new BinariesInstallError("unsupported-platform", `Unsupported platform: ${process.platform} / ${process.arch}`);
    const target = resolveToolPath(this.tool("yt-dlp"));
    this.requireManaged("yt-dlp", target);
    const releases = await fetchJson<GithubRelease[]>(`${YT_DLP_RELEASES_URL}?per_page=1`);
    const tag = releases.find((release) => !release.prerelease)?.tag_name;
    if (!tag) throw new BinariesInstallError("no-release", "No yt-dlp release found");
    const archive = join(tmpdir(), `airwave-ytdlp-${Date.now()}`);
    await downloadToFile(`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/${asset}`, archive);
    installBinaryFile(archive, target);
    rmSync(archive, { force: true });
  }

  private async installDeno(): Promise<void> {
    const asset = denoAssetName();
    if (!asset) throw new BinariesInstallError("unsupported-platform", `Unsupported platform: ${process.platform} / ${process.arch}`);
    const target = resolveToolPath(this.tool("deno"));
    this.requireManaged("deno", target);
    const releases = await fetchJson<GithubRelease[]>(`${DENO_RELEASES_URL}?per_page=1`);
    const tag = releases.find((release) => !release.prerelease && (release.tag_name ?? "").startsWith("v"))?.tag_name;
    if (!tag) throw new BinariesInstallError("no-release", "No deno release found");
    const workDir = mkdtempSync(join(tmpdir(), "airwave-deno-"));
    try {
      const archive = join(workDir, "deno.zip");
      await downloadToFile(`https://github.com/denoland/deno/releases/download/${tag}/${asset}`, archive);
      const extracted = await extractZip(archive, workDir);
      const binary = extracted.find((path) => basename(path) === "deno");
      if (!binary) throw new BinariesInstallError("extract", "Downloaded archive did not contain deno binary");
      installBinaryFile(binary, target);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async installFfmpeg(): Promise<void> {
    const asset = ffmpegAssetName();
    if (!asset) throw new BinariesInstallError("unsupported-platform", `Unsupported platform: ${process.platform} / ${process.arch}`);
    const target = resolveToolPath(this.tool("ffmpeg"));
    this.requireManaged("ffmpeg", target);
    const url = `https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/${asset}`;
    const workDir = mkdtempSync(join(tmpdir(), "airwave-ffmpeg-"));
    try {
      const archive = join(workDir, asset.endsWith(".zip") ? "ffmpeg.zip" : "ffmpeg.tar.xz");
      await downloadToFile(url, archive);
      if (archive.endsWith(".zip")) {
        await extractZip(archive, workDir);
      } else {
        await extractTarXz(archive, workDir);
      }
      const binary = findBinaryRecursive(workDir, "ffmpeg");
      if (!binary) throw new BinariesInstallError("extract", "Downloaded archive did not contain ffmpeg binary");
      installBinaryFile(binary, target);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async installFfprobe(): Promise<void> {
    const target = resolveToolPath(this.tool("ffprobe"));
    this.requireManaged("ffprobe", target);
    const slugs = martinRiedlOsArchSlugs();
    if (!slugs) throw new BinariesInstallError("unsupported-platform", `Unsupported platform: ${process.platform} / ${process.arch}`);
    const workDir = mkdtempSync(join(tmpdir(), "airwave-ffprobe-"));
    try {
      const archive = join(workDir, "ffprobe.zip");
      try {
        await downloadToFile(`https://ffmpeg.martin-riedl.de/redirect/latest/${slugs.os}/${slugs.arch}/release/ffprobe.zip`, archive);
        await extractZip(archive, workDir);
      } catch {
        const fallback = await this.martinRiedlFfprobeZipUrl();
        if (!fallback) throw new BinariesInstallError("network", "Could not download ffprobe: redirect failed and no release link found on index");
        await downloadToFile(fallback, archive);
        await extractZip(archive, workDir);
      }
      const binary = findBinaryRecursive(workDir, "ffprobe");
      if (!binary) throw new BinariesInstallError("extract", "Downloaded archive did not contain ffprobe binary");
      installBinaryFile(binary, target);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async martinRiedlFfprobeZipUrl(): Promise<string | null> {
    const heading = martinRiedlPlatformHeading();
    if (!heading) return null;
    try {
      const html = await fetchText(MARTIN_RIEDL_FFMPEG_INDEX_URL);
      const release = martinRiedlReleaseSection(html);
      if (!release) return null;
      const block = htmlSubsectionAfterH3(release, heading);
      if (!block) return null;
      const match = /href="((?:https:\/\/ffmpeg\.martin-riedl\.de)?\/download\/[^"]+ffprobe\.zip)"/.exec(block);
      const url = match?.[1];
      if (!url) return null;
      return url.startsWith("/") ? `https://ffmpeg.martin-riedl.de${url}` : url;
    } catch {
      return null;
    }
  }

  private tool(name: string): string {
    return this.tools.find((entry) => entry.name === name)?.configured ?? "";
  }
}
