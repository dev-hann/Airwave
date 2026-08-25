"""Manual migrations: the `_ensure_*_column` pattern run by init_db.

Hard rule 7 (AGENTS.md): no Alembic, no third migration path. New columns
extend this pattern.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.db.models import Base, Playlist


class _MigrationMixin:
    def init_db(self) -> None:
        Base.metadata.create_all(self.engine)
        self._ensure_playlist_thumbnail_column()
        self._ensure_playlist_description_column()
        self._ensure_play_history_thumbnail_column()
        self._ensure_provider_columns()
        self._ensure_playlist_entry_spotify_import_searched_column()
        self._ensure_playlist_can_edit_column()
        self._ensure_playlist_can_delete_column()
        self._ensure_playlist_sync_columns()
        self._ensure_playlist_entry_upstream_item_id_column()
        self._ensure_liked_songs_playlist_entry()

    def _ensure_liked_songs_playlist_entry(self) -> None:
        if self.engine.url.get_backend_name() != "sqlite":
            return
        with Session(self.engine) as session:
            existing = session.execute(select(Playlist.id).where(Playlist.title == "Liked Songs")).scalar_one_or_none()
            if existing is not None:
                return

            playlist = Playlist(
                title="Liked Songs",
                channel="Liked Songs",
                thumbnail_url="/static/images/liked_song.png",
                can_edit=False,
                can_delete=False,
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
                source_url="custom://liked_songs",
            )
            session.add(playlist)
            session.commit()
            return

    def _ensure_playlist_can_edit_column(self) -> None:
        if self.engine.url.get_backend_name() != "sqlite":
            return
        with self.engine.begin() as conn:
            column_rows = conn.execute(text("PRAGMA table_info(playlists)")).mappings().all()
            column_names = {row["name"] for row in column_rows}
            if "can_edit" not in column_names:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN can_edit INTEGER NOT NULL DEFAULT 1"))

    def _ensure_playlist_can_delete_column(self) -> None:
        if self.engine.url.get_backend_name() != "sqlite":
            return
        with self.engine.begin() as conn:
            column_rows = conn.execute(text("PRAGMA table_info(playlists)")).mappings().all()
            column_names = {row["name"] for row in column_rows}
            if "can_delete" not in column_names:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN can_delete INTEGER NOT NULL DEFAULT 1"))

    def _ensure_playlist_entry_spotify_import_searched_column(self) -> None:
        if self.engine.url.get_backend_name() != "sqlite":
            return
        with self.engine.begin() as conn:
            column_rows = conn.execute(text("PRAGMA table_info(playlist_entries)")).mappings().all()
            column_names = {row["name"] for row in column_rows}
            if "spotify_import_searched" not in column_names:
                conn.execute(
                    text(
                        "ALTER TABLE playlist_entries ADD COLUMN spotify_import_searched INTEGER NOT NULL DEFAULT 0"
                    )
                )

    def _ensure_playlist_entry_upstream_item_id_column(self) -> None:
        if self.engine.url.get_backend_name() != "sqlite":
            return
        with self.engine.begin() as conn:
            column_rows = conn.execute(text("PRAGMA table_info(playlist_entries)")).mappings().all()
            column_names = {row["name"] for row in column_rows}
            if "upstream_item_id" not in column_names:
                conn.execute(text("ALTER TABLE playlist_entries ADD COLUMN upstream_item_id TEXT"))

    def _ensure_playlist_thumbnail_column(self) -> None:
        # Existing SQLite databases need an explicit ALTER TABLE when new
        # nullable columns are introduced after the table was created.
        if self.engine.url.get_backend_name() != "sqlite":
            return
        with self.engine.begin() as conn:
            column_rows = conn.execute(text("PRAGMA table_info(playlists)")).mappings().all()
            column_names = {row["name"] for row in column_rows}
            if "thumbnail_url" not in column_names:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN thumbnail_url TEXT"))

    def _ensure_playlist_description_column(self) -> None:
        if self.engine.url.get_backend_name() != "sqlite":
            return
        with self.engine.begin() as conn:
            column_rows = conn.execute(text("PRAGMA table_info(playlists)")).mappings().all()
            column_names = {row["name"] for row in column_rows}
            if "description" not in column_names:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN description TEXT"))

    def _ensure_playlist_sync_columns(self) -> None:
        if self.engine.url.get_backend_name() != "sqlite":
            return
        with self.engine.begin() as conn:
            column_rows = conn.execute(text("PRAGMA table_info(playlists)")).mappings().all()
            column_names = {row["name"] for row in column_rows}
            if "sync_enabled" not in column_names:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 0"))
            if "sync_remove_missing" not in column_names:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN sync_remove_missing INTEGER NOT NULL DEFAULT 0"))
            if "last_sync_started_at" not in column_names:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN last_sync_started_at DATETIME"))
            if "last_sync_succeeded_at" not in column_names:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN last_sync_succeeded_at DATETIME"))
            if "last_sync_status" not in column_names:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN last_sync_status TEXT"))
            if "last_sync_error" not in column_names:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN last_sync_error TEXT"))

    def _ensure_play_history_thumbnail_column(self) -> None:
        if self.engine.url.get_backend_name() != "sqlite":
            return
        with self.engine.begin() as conn:
            column_rows = conn.execute(text("PRAGMA table_info(play_history)")).mappings().all()
            column_names = {row["name"] for row in column_rows}
            if "thumbnail_url" not in column_names:
                conn.execute(text("ALTER TABLE play_history ADD COLUMN thumbnail_url TEXT"))

    def _ensure_provider_columns(self) -> None:
        if self.engine.url.get_backend_name() != "sqlite":
            return
        tables = {
            "queue_items": ("provider", "provider_item_id"),
            "playlist_entries": ("provider", "provider_item_id"),
            "play_history": ("provider", "provider_item_id"),
        }
        with self.engine.begin() as conn:
            for table_name, columns in tables.items():
                column_rows = conn.execute(text(f"PRAGMA table_info({table_name})")).mappings().all()
                column_names = {row["name"] for row in column_rows}
                for column_name in columns:
                    if column_name in column_names:
                        continue
                    conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} TEXT"))
