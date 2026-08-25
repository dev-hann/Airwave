from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, HttpUrl

ImportMode = Literal["check", "add_all", "skip_duplicates"]


class AddUrlRequest(BaseModel):
    url: HttpUrl
    target_playlist_id: UUID | None = None
    import_mode: ImportMode | None = None


class AddLocalPathRequest(BaseModel):
    path: str = Field(min_length=1)
    import_mode: ImportMode | None = None


class AddLocalFolderRequest(BaseModel):
    path: str = Field(min_length=1)
    recursive: bool = True
    import_mode: ImportMode | None = None


class ReorderRequest(BaseModel):
    new_position: int


class SidebarPlaylistReorderRequest(BaseModel):
    playlist_id: str = Field(min_length=1)
    new_position: int
    pinned: bool


class BatchPlaylistEntryInput(BaseModel):
    source_url: str
    normalized_url: str
    provider: str | None = None
    provider_item_id: str | None = None
    title: str | None = None
    channel: str | None = None
    duration_seconds: int | None = None
    thumbnail_url: str | None = None


class BatchAddPlaylistEntriesRequest(BaseModel):
    entries: list[BatchPlaylistEntryInput] = Field(min_length=1)
    import_mode: ImportMode | None = None


class CreateCustomPlaylistRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class UpdatePlaylistRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    pinned: bool | None = None
    sync_enabled: bool | None = None
    sync_remove_missing: bool | None = None


class SpotifyImportUrlRequest(BaseModel):
    url: HttpUrl


class SpotifyImportSelectHitRequest(BaseModel):
    source_url: str = Field(min_length=1)
    normalized_url: str = Field(min_length=1)
    provider: str | None = None
    provider_item_id: str | None = None
    title: str | None = None
    channel: str | None = None
    duration_seconds: int | None = None
    thumbnail_url: str | None = None


class RepeatModeRequest(BaseModel):
    mode: str = Field(pattern="^(off|all|one)$")


class ShuffleModeRequest(BaseModel):
    enabled: bool


class SeekRequest(BaseModel):
    percent: float = Field(ge=0.0, le=100.0)


class InstallBinaryRequest(BaseModel):
    name: str = Field(pattern="^(yt-dlp|ffmpeg|ffprobe|deno)$")
    stop_stream_first: bool = False


class CookieSettingUpdateRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=50)
    value: str = Field(min_length=1)


# ---------------------------------------------------------------------------
# Response contracts (wire-format source of truth)
#
# These mirror _serialize_state/_serialize_queue_items/_serialize_history_rows
# in serializers.py field-for-field. They exist so FastAPI emits them into the
# OpenAPI schema, which scripts/export_openapi.py + openapi-typescript turn
# into the frontend's generated TS types (packages/shared/src/generated).
# Golden-fixture tests guard the actual JSON; these models must stay in sync
# with the serializers in the same commit.
# ---------------------------------------------------------------------------

PlaybackModeValue = Literal["idle", "playing"]
RepeatModeValue = Literal["off", "all", "one"]


class PlaybackStateContract(BaseModel):
    mode: PlaybackModeValue
    paused: bool
    repeat_mode: RepeatModeValue
    shuffle_enabled: bool
    can_seek: bool
    now_playing_id: int | None
    now_playing_title: str | None
    now_playing_channel: str | None
    now_playing_thumbnail_url: str | None
    now_playing_is_live: bool
    now_playing_is_liked: bool
    stream_url: str
    duration_seconds: int | None
    started_at: float | None
    elapsed_seconds: float | None
    progress_percent: float | None


class QueueItemContract(BaseModel):
    id: int
    title: str | None
    source_url: str
    provider: str | None
    provider_item_id: str | None
    status: str
    queue_position: int
    source_type: str
    channel: str | None
    duration_seconds: int | None
    thumbnail_url: str | None
    playlist_id: UUID | None


class HistoryRowContract(BaseModel):
    id: int
    queue_item_id: int | None
    title: str | None
    source_url: str
    provider: str | None
    provider_item_id: str | None
    thumbnail_url: str | None
    status: str
    started_at: datetime | str | None
    finished_at: datetime | str | None
    error_message: str | None


class UiSnapshotContract(BaseModel):
    """Composite shape served on the WS snapshot and mirrored by
    /api/_contracts/snapshot for codegen visibility."""

    type: Literal["snapshot"]
    timestamp: float
    state: PlaybackStateContract
    queue: list[QueueItemContract]
    history: list[HistoryRowContract]
    playlists: list[dict[str, object]]
