/**
 * ffmpeg/ffprobe subprocess pipeline — port of app/services/ffmpeg_pipeline.py.
 *
 * Hard rule preserved: list-argv spawns only, never shell, never string
 * interpolation. Remote inputs get reconnect/timeout flags so a TCP black
 * hole cannot hang the shared stream.
 */

import { spawn } from "node:child_process";

export class FfmpegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegError";
  }
}

export interface SpawnedProcess {
  readonly process: import("node:child_process").ChildProcess;
  readonly stdout: import("node:stream").Readable;
  readonly stderrBuffer: () => string;
  returnCode(): Promise<number | null>;
  write(data: Buffer): void;
  end(): void;
  kill(): Promise<void>;
}

const wrap = (process: import("node:child_process").ChildProcess): SpawnedProcess => {
  const stderrChunks: Buffer[] = [];
  process.stderr?.on("data", (chunk: Buffer) => {
    // Bounded capture: keep the last 64KB for failure diagnostics.
    stderrChunks.push(chunk);
    if (stderrChunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) stderrChunks.shift();
  });
  return {
    process,
    stdout: process.stdout as import("node:stream").Readable,
    stderrBuffer: () => Buffer.concat(stderrChunks).toString("utf-8"),
    returnCode: () =>
      new Promise((resolve) => {
        if (process.exitCode !== null) resolve(process.exitCode);
        else process.once("exit", (code) => resolve(code));
      }),
    write: (data: Buffer) => process.stdin?.write(data),
    end: () => process.stdin?.end(),
    kill: () =>
      new Promise((resolve) => {
        if (process.exitCode !== null) {
          resolve();
          return;
        }
        process.kill("SIGTERM");
        const timer = setTimeout(() => {
          process.kill("SIGKILL");
          resolve();
        }, 1000);
        process.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
};

export class FfmpegPipeline {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string = "ffprobe",
    private readonly bitrate = "320k",
  ) {}

  /** Per-track decoder: source → continuous MP3 on stdout (tag-free for the packager). */
  spawnForSource(sourceUrl: string, startAtSeconds = 0): SpawnedProcess {
    const args: string[] = ["-re"];
    if (/^https?:\/\//.test(sourceUrl)) {
      args.push(
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-rw_timeout", "15000000",
      );
    }
    if (startAtSeconds > 0) args.push("-ss", startAtSeconds.toFixed(3));
    args.push(
      "-i", sourceUrl,
      "-vn",
      "-acodec", "libmp3lame",
      "-ar", "44100",
      "-ac", "2",
      "-write_xing", "0",
      "-id3v2_version", "0",
      "-b:a", this.bitrate,
      "-f", "mp3",
      "pipe:1",
    );
    return wrap(spawn(this.ffmpegPath, ["-hide_banner", "-nostats", "-loglevel", "warning", ...args], { stdio: ["ignore", "pipe", "pipe"] }));
  }

  /** Silence generator for idle/transition padding (same codec parameters). */
  spawnSilence(): SpawnedProcess {
    const args = [
      "-re",
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-acodec", "libmp3lame",
      "-ar", "44100",
      "-ac", "2",
      "-write_xing", "0",
      "-id3v2_version", "0",
      "-b:a", this.bitrate,
      "-f", "mp3",
      "pipe:1",
    ];
    return wrap(spawn(this.ffmpegPath, ["-hide_banner", "-nostats", "-loglevel", "warning", ...args], { stdio: ["ignore", "pipe", "pipe"] }));
  }

  /** Long-running HLS packager: continuous MP3 on stdin → AAC MPEG-TS segments. */
  spawnHlsPackager(
    playlistPath: string,
    segmentPattern: string,
    options: { startNumber?: number; segmentSeconds?: number; hlsBitrate?: string } = {},
  ): SpawnedProcess {
    const { startNumber = 0, segmentSeconds = 4, hlsBitrate = "192k" } = options;
    const args = [
      "-f", "mp3",
      "-i", "pipe:0",
      "-c:a", "aac",
      "-b:a", hlsBitrate,
      "-ar", "44100",
      "-ac", "2",
      "-f", "hls",
      "-hls_time", Math.max(0.5, segmentSeconds).toFixed(3),
      "-hls_list_size", "60",
      "-start_number", String(Math.max(0, Math.trunc(startNumber))),
      "-hls_flags", "append_list+omit_endlist+independent_segments",
      "-hls_segment_filename", segmentPattern,
      playlistPath,
    ];
    const proc = spawn(this.ffmpegPath, ["-hide_banner", "-nostats", "-loglevel", "warning", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    return wrap(proc);
  }

  /** Probe duration/format; null duration when probing fails. */
  async probeSource(sourceUrl: string): Promise<{ durationSeconds: number | null; bitRate: number | null; formatName: string | null }> {
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const proc = spawn(this.ffprobePath, [
        "-v", "error",
        "-show_entries", "format=duration,bit_rate,format_name",
        "-of", "json",
        sourceUrl,
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (chunk) => (stdout += chunk));
      proc.stderr?.on("data", (chunk) => (stderr += chunk));
      proc.once("error", reject);
      proc.once("close", (code) => resolve({ stdout, stderr, code }));
    });
    if (result.code !== 0) {
      throw new FfmpegError(result.stderr.trim() || "ffprobe failed");
    }
    try {
      const payload = JSON.parse(result.stdout || "{}") as { format?: Record<string, string> };
      const format = payload.format ?? {};
      const duration = format["duration"] ? Number(format["duration"]) : NaN;
      const bitRate = format["bit_rate"] ? Number(format["bit_rate"]) : NaN;
      return {
        durationSeconds: Number.isFinite(duration) ? duration : null,
        bitRate: Number.isFinite(bitRate) ? bitRate : null,
        formatName: format["format_name"] ?? null,
      };
    } catch {
      throw new FfmpegError("Invalid JSON from ffprobe");
    }
  }
}
