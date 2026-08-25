from __future__ import annotations

import json
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AIRWAVE_", env_file=".env", extra="ignore")

    app_name: str = "Airwave"
    # Injected by CI via Docker build-arg; "dev" for bare-metal/local runs.
    app_version: str = "dev"
    db_url: str = "sqlite+pysqlite:///./data/airwave.db"
    host: str = "0.0.0.0"
    port: int = 8000
    stream_path: str = "/stream/live.mp3"
    yt_dlp_path: str = "./bin/yt-dlp"
    ffmpeg_path: str = "./bin/ffmpeg"
    ffprobe_path: str = "./bin/ffprobe"
    deno_path: str = "./bin/deno"
    mp3_bitrate: str = "320k"
    # Keep FFmpeg reads large enough to tolerate scheduler jitter without adding
    # noticeable live-stream latency. Tiny chunks can cause occasional underruns.
    chunk_size: int = 4096
    # Per-listener buffer depth (~6.5s at 320kbps with 4KB chunks). Larger values
    # let slow/mobile consumers survive short stalls without dropping chunks.
    stream_queue_size: int = 64
    queue_poll_seconds: float = Field(default=1.0, ge=0.1, le=10.0)
    stream_stats_log_seconds: float = Field(default=15.0, ge=1.0, le=300.0)
    history_limit: int = 50
    log_level: str = Field(default="INFO", description="Logging level (debug, info, warning, error)")
    playlist_sync_interval_seconds: int = Field(default=3600, ge=30)
    playlist_sync_max_concurrent: int = Field(default=2, ge=1, le=10)
    # Must remain `str` (not list[str]): pydantic-settings JSON-decodes list fields from env before
    # validators run, so values like `/mnt` or `a,b` would raise. Parse via local_media_roots_list.
    local_media_roots: str = Field(
        default="",
        description="Comma-separated paths, or a JSON array string, for AIRWAVE_LOCAL_MEDIA_ROOTS",
    )
    # Manual app-update trigger (proxied to a Watchtower HTTP API on the host).
    # Both empty by default: the upgrade endpoint returns 503 and the UI hides the button.
    watchtower_url: str = ""
    watchtower_token: str = ""

    @staticmethod
    def _parse_local_media_roots_input(raw: str) -> list[str]:
        text = (raw or "").strip()
        if not text:
            return []
        if text.startswith("["):
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                return [p.strip() for p in text.split(",") if p.strip()]
            if isinstance(parsed, list):
                return [str(v).strip() for v in parsed if str(v).strip()]
        return [p.strip() for p in text.split(",") if p.strip()]

    @property
    def local_media_roots_list(self) -> list[str]:
        return self._parse_local_media_roots_input(self.local_media_roots)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
