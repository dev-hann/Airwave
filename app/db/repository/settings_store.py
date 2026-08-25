"""Key/value settings domain."""

from __future__ import annotations

from app.db.models import Setting


class _SettingsStoreMixin:
    def get_setting(self, key: str) -> str | None:
        with self.session() as session:
            setting = session.get(Setting, key)
            return None if setting is None else setting.value

    def set_setting(self, key: str, value: str) -> None:
        with self.session() as session:
            setting = session.get(Setting, key)
            if setting is None:
                session.add(Setting(key=key, value=value))
            else:
                setting.value = value

    def clear_setting(self, key: str) -> None:
        with self.session() as session:
            setting = session.get(Setting, key)
            if setting is not None:
                session.delete(setting)
