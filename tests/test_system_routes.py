from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api.system import routes as system_routes
from app.core.config import Settings
from app.main import create_app


def _make_client(tmp_path, **extra):
    settings = Settings(
        db_url=f"sqlite+pysqlite:///{tmp_path}/system.db",
        yt_dlp_path="/bin/echo",
        ffmpeg_path="/bin/echo",
        **extra,
    )
    app = create_app(settings=settings, start_engine=False)
    return TestClient(app)


def _reset_updates_cache():
    # "at" far in the past: on short-lived CI runners time.monotonic() can be
    # < 300s since boot, and a reset value of 0.0 would look like a fresh cache.
    system_routes._updates_cache["at"] = -1e9
    system_routes._updates_cache["latest"] = None


def test_version_defaults_to_dev(tmp_path):
    with _make_client(tmp_path) as client:
        response = client.get("/api/system/version")
        assert response.status_code == 200
        payload = response.json()
        assert payload["version"] == "dev"
        assert payload["is_release"] is False


def test_version_release_tag(tmp_path):
    with _make_client(tmp_path, app_version="v0.2.0") as client:
        payload = client.get("/api/system/version").json()
        assert payload["version"] == "v0.2.0"
        assert payload["is_release"] is True


def test_updates_reports_newer_release(tmp_path, monkeypatch):
    _reset_updates_cache()

    def fake_get(url, **kwargs):
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"tag_name": "v0.2.1"},
        )

    monkeypatch.setattr(system_routes.httpx, "get", fake_get)
    with _make_client(tmp_path, app_version="v0.2.0") as client:
        payload = client.get("/api/system/updates").json()
    assert payload["current"] == "v0.2.0"
    assert payload["latest"] == "v0.2.1"
    assert payload["has_update"] is True
    assert payload["can_upgrade"] is False
    assert payload["releases_url"].endswith("/releases")


def test_updates_swallows_github_failure(tmp_path, monkeypatch):
    _reset_updates_cache()

    def fake_get(url, **kwargs):
        raise system_routes.httpx.ConnectError("boom")

    monkeypatch.setattr(system_routes.httpx, "get", fake_get)
    with _make_client(tmp_path) as client:
        response = client.get("/api/system/updates")
    assert response.status_code == 200
    payload = response.json()
    assert payload["latest"] is None
    assert payload["has_update"] is False


def test_upgrade_returns_503_when_not_configured(tmp_path):
    with _make_client(tmp_path) as client:
        response = client.post("/api/system/upgrade")
    assert response.status_code == 503


def test_upgrade_proxies_to_watchtower(tmp_path, monkeypatch):
    calls = {}

    def fake_post(url, **kwargs):
        calls["url"] = url
        calls["headers"] = kwargs.get("headers")
        return SimpleNamespace(status_code=200)

    monkeypatch.setattr(system_routes.httpx, "post", fake_post)
    with _make_client(
        tmp_path,
        watchtower_url="http://127.0.0.1:8080/",
        watchtower_token="secret",
    ) as client:
        response = client.post("/api/system/upgrade")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert calls["url"] == "http://127.0.0.1:8080/v1/update"
    assert calls["headers"]["Authorization"] == "Bearer secret"


def test_upgrade_returns_502_when_watchtower_down(tmp_path, monkeypatch):
    def fake_post(url, **kwargs):
        raise system_routes.httpx.ConnectError("watchtower down")

    monkeypatch.setattr(system_routes.httpx, "post", fake_post)
    with _make_client(tmp_path, watchtower_url="http://127.0.0.1:8080") as client:
        response = client.post("/api/system/upgrade")
    assert response.status_code == 502


def test_upgrade_returns_502_on_watchtower_error_status(tmp_path, monkeypatch):
    def fake_post(url, **kwargs):
        return SimpleNamespace(status_code=401)

    monkeypatch.setattr(system_routes.httpx, "post", fake_post)
    with _make_client(tmp_path, watchtower_url="http://127.0.0.1:8080") as client:
        response = client.post("/api/system/upgrade")
    assert response.status_code == 502
