/**
 * Media source resolver — port of app/services/source_resolver.py (subset).
 *
 * Local media: AIRWAVE_LOCAL_MEDIA_ROOTS allowlist (path-traversal guarded),
 * directory browsing, audio-extension filtering. Direct HTTP media: probed
 * via ffprobe to verify a playable audio stream.
 */

import { realpathSync, existsSync, statSync, readdirSync, accessSync, constants } from "node:fs";
import { basename, extname } from "node:path";

export interface ResolvedMediaTrack {
  sourceUrl: string;
  normalizedUrl: string;
  title: string | null;
  channel: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  isDirectFile: boolean;
}

export interface BrowseEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

const AUDIO_EXTENSIONS = new Set([
  ".aac", ".ac3", ".aiff", ".alac", ".ape", ".flac", ".m4a", ".m4b", ".mkv",
  ".mov", ".mp3", ".mp4", ".mpc", ".ogg", ".opus", ".wav", ".webm", ".wma",
]);

function expandHome(input: string): string {
  if (input === "~") return process.env.HOME ?? input;
  if (input.startsWith("~/")) return (process.env.HOME ?? "") + input.slice(1);
  return input;
}

export class MediaSourceResolver {
  private readonly roots: string[];
  private readonly probe: (url: string) => Promise<{ durationSeconds: number | null; formatName: string | null }>;

  constructor(
    roots: string[],
    probeSource: (url: string) => Promise<{ durationSeconds: number | null; formatName: string | null }>,
  ) {
    this.roots = roots
      .map((root) => {
        try {
          return realpathSync(expandHome(root));
        } catch {
          return null;
        }
      })
      .filter((root): root is string => root !== null);
    this.probe = probeSource;
  }

  get configured(): boolean {
    return this.roots.length > 0;
  }

  listRootsPayload(): Array<{ path: string; name: string }> {
    return this.roots.map((root) => ({ path: root, name: basename(root) || root }));
  }

  /** Resolve a user-supplied path inside the allowlist (traversal guarded). */
  resolveUnderRoot(requestedPath: string): string {
    if (this.roots.length === 0) {
      throw new Error("Local media is disabled (no AIRWAVE_LOCAL_MEDIA_ROOTS configured)");
    }
    const expanded = expandHome((requestedPath || "").trim());
    let real: string;
    try {
      real = realpathSync(expanded);
    } catch {
      throw new Error("Path does not exist");
    }
    if (!this.roots.some((root) => real === root || real.startsWith(root + "/"))) {
      throw new Error("Path is outside allowed media directories");
    }
    return real;
  }

  /** List audio files under a directory (extension filter + allowlist + readable). */
  listCandidateAudioFiles(directoryPath: string, recursive: boolean): string[] {
    const resolved = this.resolveUnderRoot(directoryPath);
    if (!statSync(resolved).isDirectory()) throw new Error("Not a directory");
    const found: string[] = [];
    const consider = (full: string) => {
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        return;
      }
      if (!this.roots.some((root) => real === root || real.startsWith(root + "/"))) return;
      let st;
      try {
        st = statSync(real);
      } catch {
        return;
      }
      if (!st.isFile()) return;
      try {
        accessSync(real, constants.R_OK);
      } catch {
        return;
      }
      if (!AUDIO_EXTENSIONS.has(extname(real).toLowerCase())) return;
      found.push(real);
    };
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        if (name.startsWith(".")) continue;
        const full = `${dir}/${name}`;
        if (statSync(full).isDirectory()) {
          if (recursive) walk(full);
        } else {
          consider(full);
        }
      }
    };
    walk(resolved);
    return found.sort();
  }

  /** Directory listing for the explorer UI. */
  browseDirectory(directoryPath: string): { path: string; entries: BrowseEntry[] } {
    const resolved = this.resolveUnderRoot(directoryPath);
    if (!statSync(resolved).isDirectory()) throw new Error("Not a directory");
    const entries: BrowseEntry[] = [];
    for (const name of readdirSync(resolved).sort()) {
      if (name.startsWith(".")) continue;
      const full = `${resolved}/${name}`;
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }
      let st;
      try {
        st = statSync(real);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        entries.push({ name, path: real, kind: "directory" });
        continue;
      }
      if (!st.isFile()) continue;
      try {
        accessSync(real, constants.R_OK);
      } catch {
        continue;
      }
      if (!AUDIO_EXTENSIONS.has(extname(name).toLowerCase())) continue;
      entries.push({ name, path: real, kind: "file" });
    }
    return { path: resolved, entries };
  }

  /** Local file → queue item metadata (title from filename; ffmpeg probes at play time). */
  resolveLocalFile(path: string): ResolvedMediaTrack {
    const real = this.resolveUnderRoot(path);
    if (!statSync(real).isFile()) throw new Error("Not a file");
    const ext = extname(real).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) throw new Error("Not a supported audio file");
    return {
      sourceUrl: `file://${real}`,
      normalizedUrl: `file://${real}`,
      title: basename(real, ext) || basename(real),
      channel: null,
      durationSeconds: null,
      thumbnailUrl: null,
      isDirectFile: true,
    };
  }

  /** Direct HTTP media URL → queue item metadata via ffprobe. */
  async resolveHttpMedia(url: string): Promise<ResolvedMediaTrack> {
    const text = (url || "").trim();
    if (!/^https?:\/\//i.test(text)) throw new Error("Direct media URL must start with http:// or https://");
    let duration: number | null = null;
    try {
      const probe = await this.probe(text);
      duration = probe.durationSeconds && probe.durationSeconds > 0 ? Math.round(probe.durationSeconds) : null;
    } catch {
      throw new Error("Could not read media URL");
    }
    if (duration === null) {
      // No duration readable — accept only if the probe could read the format at all.
      try {
        const probe = await this.probe(text);
        if (!probe.formatName) throw new Error("URL does not appear to contain a playable audio stream");
      } catch {
        throw new Error("URL does not appear to contain a playable audio stream");
      }
    }
    const title = decodeURIComponent(new URL(text).pathname.split("/").pop() || "").replace(/\.[a-z0-9]+$/i, "") || text;
    return {
      sourceUrl: text,
      normalizedUrl: text,
      title: title || null,
      channel: null,
      durationSeconds: duration,
      thumbnailUrl: null,
      isDirectFile: false,
    };
  }
}
