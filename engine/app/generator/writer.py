"""The only module allowed to touch the filesystem."""
from __future__ import annotations

import os
import stat
import sys
from pathlib import PureWindowsPath
from dataclasses import asdict
from pathlib import Path

from .base import GeneratedFile, UnsafeIdentifier, safe_relpath
from .merge import Action, FilePlan, plan_file


def contained_path(target: Path, rel: str) -> Path:
    """Resolve ``rel`` under ``target`` and refuse to escape it.

    Last line of defence: even if a generator emitted something hostile,
    nothing is ever written outside the project directory.
    """
    rel = safe_relpath(rel)
    root = _guard_target(target)
    dest = root / rel
    if not dest.is_relative_to(root):
        raise UnsafeIdentifier(f"path escapes project directory: {rel!r}")
    # Never follow a pre-existing symlink, even one currently pointing inside
    # the project. Recheck after mkdir in apply_plan as well.
    current = root
    for part in rel.split("/"):
        current = current / part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode):
            raise UnsafeIdentifier(f"symlink in generated path: {current}")
    return dest


def default_workspace() -> Path:
    """Documents/SkaffoProjects on every OS.

    Projects generated before the rename live in `CodeForgeProjects`; that
    folder is reused if it exists so nobody has to move their work.
    """
    if sys.platform == "win32":
        docs = Path(os.environ.get("USERPROFILE", Path.home())) / "Documents"
    else:
        docs = Path.home() / "Documents"
    new = docs / "SkaffoProjects"
    legacy = docs / "CodeForgeProjects"
    if not new.exists() and legacy.exists():
        return legacy
    return new


def _under_workspace(tail: str, slug: str) -> Path:
    """Join a workspace-relative tail, refusing to leave the workspace.

    SECURITY-003. ``~/Projects/<tail>`` is the UI's own notation for "inside
    the managed workspace", so the tail is untrusted and must not be able to
    climb out of it with ``..``. ``Path.__truediv__`` happily builds
    ``.../SkaffoProjects/../../../tmp``; only resolving and re-checking
    catches that.
    """
    ws = default_workspace().resolve()
    candidate = (ws / tail).resolve() if tail else ws / slug

    try:
        candidate.relative_to(ws)
    except ValueError:
        # The tail escaped. Fall back to the hardened slug rather than
        # silently writing somewhere the user never chose.
        return ws / slug
    return candidate


def resolve_target(raw: str | None, slug: str) -> Path:
    """Expand a stored project path into a real absolute directory."""
    slug = safe_relpath(slug)
    if "/" in slug:
        raise ValueError("project slug must be a single segment")
    text = (raw or "").strip()
    if text in ("", "~", "~/Projects", "~/Projects/"):
        return _guard_target(default_workspace() / slug)

    win = PureWindowsPath(text)
    if os.name != "nt" and (win.drive or text.startswith("\\\\")):
        raise ValueError("Windows paths are not valid on this platform")
    if os.name == "nt" and win.drive and not win.is_absolute():
        raise ValueError("drive-relative paths are not allowed")

    # Match the UI notation on a component boundary, not a string prefix.
    if text.startswith(("~/Projects/", "~/Projects\\")):
        tail = text[len("~/Projects/"):].replace("\\", "/")
        return _guard_target(_under_workspace(tail, slug))

    p = Path(text).expanduser()
    if not p.is_absolute():
        return _guard_target(_under_workspace(str(p), slug))
    return _guard_target(p)


# Compare components, not prefixes: /usr2 is not /usr.
_SYSTEM_UNIX = ("/etc", "/usr", "/bin", "/sbin", "/boot", "/dev",
                "/proc", "/sys", "/var", "/lib", "/lib64", "/opt", "/run")
_SYSTEM_WIN = {"windows", "program files", "program files (x86)",
               "programdata", "$recycle.bin", "system volume information"}


def _guard_target(p: Path) -> Path:
    """Refuse OS roots, home itself, and system directories and descendants."""
    expanded = p.expanduser().absolute()
    current = Path(expanded.anchor)
    for part in expanded.parts[1:]:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"refusing symlink output directory: {current}")
    resolved = expanded.resolve()
    if resolved == Path.home().resolve() or resolved == Path(resolved.anchor):
        raise ValueError(f"refusing to generate into system directory: {resolved}")
    if os.name == "nt":
        if len(resolved.parts) < 3 or resolved.parts[1].casefold() in _SYSTEM_WIN:
            raise ValueError(f"refusing to generate into system directory: {resolved}")
    elif any(resolved.is_relative_to(Path(parent)) for parent in _SYSTEM_UNIX):
        raise ValueError(f"refusing to generate into system directory: {resolved}")
    return resolved


def build_plan(files: list[GeneratedFile], target: Path) -> list[FilePlan]:
    """Compare rendered output against what's already on disk."""
    plans: list[FilePlan] = []
    for f in files:
        dest = contained_path(target, f.path)
        existing = None
        if dest.exists() and dest.is_file():
            try:
                existing = dest.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                existing = None
        plans.append(plan_file(f.path, f.content, existing))
    return plans


def apply_plan(
    plans: list[FilePlan],
    target: Path,
    *,
    overwrite_conflicts: bool = False,
) -> dict:
    """Write files. Conflicts are skipped unless explicitly allowed."""
    target = _guard_target(target)
    target.mkdir(parents=True, exist_ok=True)

    written = skipped = merged = conflicts = 0
    total_bytes = 0
    conflict_paths: list[str] = []

    for p in plans:
        if p.action is Action.SKIP:
            skipped += 1
            continue

        if p.action is Action.CONFLICT and not overwrite_conflicts:
            conflicts += 1
            conflict_paths.append(p.path)
            continue

        dest = contained_path(target, p.path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest = contained_path(target, p.path)
        dest.write_text(p.content, encoding="utf-8", newline="\n")

        total_bytes += len(p.content.encode("utf-8"))
        written += 1
        if p.action is Action.MERGE:
            merged += 1

    return {
        "target": str(target),
        "written": written,
        "merged": merged,
        "skipped": skipped,
        "conflicts": conflicts,
        "conflictPaths": conflict_paths,
        "bytes": total_bytes,
    }


def plan_to_dict(p: FilePlan) -> dict:
    d = asdict(p)
    d["action"] = p.action.value
    d.pop("content", None)          # keep the payload small
    return d


def count_lines(files: list[GeneratedFile]) -> int:
    return sum(f.content.count("\n") + 1 for f in files if f.content)
