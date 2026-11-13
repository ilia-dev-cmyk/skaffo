"""Behavioral regressions for filesystem output and sidecar access."""
from pathlib import Path
import os

import pytest
from fastapi.testclient import TestClient

from app.generator.base import GeneratedFile, UnsafeIdentifier, project_slug
from app.generator.merge import Action, FilePlan
from app.generator.writer import apply_plan, build_plan, contained_path, resolve_target
from app.services.export import build_zip, write_zip, reveal_in_explorer
from app.main import app
from app.core.config import settings


@pytest.mark.parametrize("bad", [
    "//server/share/file", "\\\\server\\share\\file", "C:relative.txt",
    "a:stream", "a/./b", "a//b", "a/../b", "nul.txt", "COM1.py",
    "name. ", "a/", "a\x00b", "/abs", "C:\\abs\\file",
])
def test_portable_generated_paths_reject_special_names(bad):
    with pytest.raises(UnsafeIdentifier):
        GeneratedFile(bad, "x")


def test_reserved_project_name_still_generates_portable_slug():
    for name in ("CON", "COM1", "NUL"):
        slug = project_slug(name)
        assert slug.endswith("-project")
        assert GeneratedFile(f"{slug}/README.md", "ok").path


def test_existing_symlink_cannot_redirect_plan_or_write(tmp_path):
    root = tmp_path / "output"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    try:
        (root / "link").symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable on this platform")
    files = [GeneratedFile("link/escape.txt", "secret")]
    with pytest.raises(ValueError):
        resolve_target(str(root / "link"), "demo")
    with pytest.raises(UnsafeIdentifier):
        build_plan(files, root)
    with pytest.raises(UnsafeIdentifier):
        apply_plan([FilePlan("link/escape.txt", Action.CREATE, "secret")], root)
    assert not (outside / "escape.txt").exists()


def test_symlink_created_after_planning_is_rechecked(tmp_path):
    root = tmp_path / "output"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    plans = build_plan([GeneratedFile("link/escape.txt", "secret")], root)
    try:
        (root / "link").symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable on this platform")
    with pytest.raises(UnsafeIdentifier):
        apply_plan(plans, root)
    assert not (outside / "escape.txt").exists()


def test_system_descendants_rejected_even_before_directory_exists():
    if os.name == "nt":
        candidates = ["C:\\Windows\\System32\\new", "C:\\Program Files\\new"]
    else:
        candidates = ["/etc/skaffo-new", "/usr/local/skaffo-new", "/var/tmp/skaffo-new"]
    for candidate in candidates:
        with pytest.raises(ValueError):
            resolve_target(candidate, "demo")
        with pytest.raises(ValueError):
            contained_path(Path(candidate), "data.txt")


def test_windows_absolute_paths_on_posix_not_interpreted_as_workspace():
    if os.name == "nt":
        pytest.skip("POSIX-specific path handling")
    for candidate in ("C:\\Windows\\foo", "C:/Users/Public/foo", "\\\\server\\share\\foo"):
        with pytest.raises(ValueError):
            resolve_target(candidate, "demo")


def test_workspace_notation_requires_component_boundary(tmp_path, monkeypatch):
    from app.generator import writer
    monkeypatch.setattr(writer, "default_workspace", lambda: tmp_path / "workspace")
    assert writer.resolve_target("~/ProjectsExtra", "demo") != tmp_path / "workspace" / "Extra"
    assert writer.resolve_target("~/Projects/../escaped", "demo") == tmp_path / "workspace" / "demo"


def test_zip_root_must_be_single_directory():
    with pytest.raises(UnsafeIdentifier):
        build_zip([GeneratedFile("good.txt", "data")], "safe/nested")


def test_zip_export_refuses_system_directory():
    if os.name != "nt":
        with pytest.raises(ValueError):
            write_zip([GeneratedFile("good.txt", "data")], Path("/etc/skaffo.zip"), "demo")


def test_zip_export_refuses_symlink_destination(tmp_path):
    outside = tmp_path / "private.txt"
    outside.write_text("untouched")
    target = tmp_path / "archive.zip"
    try:
        target.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable on this platform")
    with pytest.raises(ValueError):
        write_zip([GeneratedFile("good.txt", "data")], target, "demo")
    assert outside.read_text() == "untouched"


def test_reveal_file_opens_parent_not_file_association(tmp_path, monkeypatch):
    from app.services import export
    script = tmp_path / "run.bat"
    script.write_text("malicious example")
    opened = []
    monkeypatch.setattr(export.sys, "platform", "win32")
    monkeypatch.setattr(export.os, "startfile", lambda path: opened.append(path), raising=False)
    assert reveal_in_explorer(script)
    assert opened == [str(tmp_path)]


def test_zip_route_reports_invalid_destination_as_client_error():
    if os.name == "nt":
        pytest.skip("POSIX system path")
    with TestClient(app) as client:
        project = client.post("/api/projects", json={
            "name": "Zip guard", "description": "",
            "stack": {"backend": "fastapi", "frontend": "react",
                      "database": "sqlite", "auth": "none"},
        })
        assert project.status_code == 201
        pid = project.json()["id"]
        try:
            result = client.post(f"/api/projects/{pid}/generate/zip",
                                 json={"path": "/etc/skaffo.zip"})
            assert result.status_code == 400
            assert "system directory" in result.json()["detail"]
        finally:
            client.delete(f"/api/projects/{pid}")


def test_local_api_rejects_other_origins_and_hosts():
    with TestClient(app) as client:
        port = settings.PORT
        assert client.get("/health", headers={"host": f"127.0.0.1:{port}"}).status_code == 200
        assert client.get("/health", headers={"host": "evil.example"}).status_code == 403
        assert client.post("/api/projects", headers={"host": f"127.0.0.1:{port}",
            "origin": "https://evil.example"}, json={}).status_code == 403
        assert client.get("/health", headers={"host": f"127.0.0.1:{port}",
            "origin": "http://localhost:5273"}).status_code == 200


def test_electron_sidecar_requires_token_for_reads_and_writes(monkeypatch):
    monkeypatch.setenv("SKAFFO_ENGINE_TOKEN", "test-secret")
    host = {"host": f"127.0.0.1:{settings.PORT}"}
    with TestClient(app) as client:
        assert client.get("/health", headers=host).status_code == 401
        assert client.post("/api/projects", json={}, headers=host).status_code == 401
        assert client.get("/health", headers={**host, "x-skaffo-token": "wrong"}).status_code == 401
        assert client.get("/health", headers={**host, "x-skaffo-token": "test-secret"}).status_code == 200
        assert client.get("/health", headers={**host, "x-skaffo-token": "test-secret",
            "origin": "https://evil.example"}).status_code == 403
        assert client.get("/health", headers={"host": "evil.example",
            "x-skaffo-token": "test-secret"}).status_code == 403
