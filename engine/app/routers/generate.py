"""Project generation endpoints — preview, generate, read a generated file."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import models
from ..core.database import get_db
from ..generator import GenContext, run_all
from ..generator.writer import (
    apply_plan, build_plan, count_lines, default_workspace, plan_to_dict, resolve_target,
)
from ..services.export import (
    default_zip_path, export_report, file_diff, reveal_in_explorer, run_scripts,
    summarize_plans, write_zip,
)
from ..services.serialize import project_out

router = APIRouter(prefix="/api/projects/{pid}/generate", tags=["generator"])


class GenerateRequest(BaseModel):
    overwriteConflicts: bool = False
    path: str | None = None
    includeRunScripts: bool = True
    dryRun: bool = False


def _files_for(p: models.Project, ctx: GenContext, include_scripts: bool = True):
    """Rendered output plus the optional launcher scripts."""
    files = run_all(ctx)
    if include_scripts:
        existing = {f.path for f in files}
        files = files + [f for f in run_scripts(p.name) if f.path not in existing]
    return sorted(files, key=lambda f: f.path)


def _ctx(db: Session, pid: str) -> tuple[models.Project, GenContext]:
    p = db.get(models.Project, pid)
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"project {pid} not found")
    data = project_out(p)
    return p, GenContext(
        project=data,
        tables=data["schema"]["tables"],
        relations=data["schema"]["relations"],
        endpoints=data["api"]["endpoints"],
        crud_options=data["api"]["crudOptions"],
    )


@router.get("/preview")
def preview(pid: str, db: Session = Depends(get_db)):
    """Render everything in memory and diff against disk. Writes nothing."""
    p, ctx = _ctx(db, pid)
    files = _files_for(p, ctx)
    target = resolve_target(p.path, ctx.slug)
    plans = build_plan(files, target)
    summary = summarize_plans(plans)

    return {
        "target": str(target),
        "zipPath": str(default_zip_path(ctx.slug)),
        "fileCount": len(files),
        "lines": count_lines(files),
        "bytes": sum(len(f.content.encode()) for f in files),
        "counts": summary["counts"],
        "changed": summary["changed"],
        "files": [plan_to_dict(pl) for pl in plans],
        "tree": sorted(f.path for f in files),
    }


@router.post("")
def generate(pid: str, body: GenerateRequest, db: Session = Depends(get_db)):
    """Render and write to disk."""
    p, ctx = _ctx(db, pid)
    files = _files_for(p, ctx, body.includeRunScripts)

    try:
        target = resolve_target(body.path or p.path, ctx.slug)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    plans = build_plan(files, target)

    if body.dryRun:
        # Report exactly what *would* happen and touch nothing.
        summary = summarize_plans(plans)
        return {
            "dryRun": True,
            "target": str(target),
            "fileCount": len(files),
            "lines": count_lines(files),
            "bytes": sum(len(f.content.encode()) for f in files),
            "counts": summary["counts"],
            "changed": summary["changed"],
            "written": 0,
            "merged": 0,
            "skipped": summary["counts"].get("skip", 0),
            "conflicts": summary["counts"].get("conflict", 0),
            "conflictPaths": [pl.path for pl in plans if pl.action.value == "conflict"],
            "files": [plan_to_dict(pl) for pl in plans],
            "project": project_out(p),
        }

    result = apply_plan(plans, target, overwrite_conflicts=body.overwriteConflicts)

    p.file_count = len(files)
    p.lines_of_code = count_lines(files)
    p.last_build_at = datetime.now(timezone.utc)
    p.path = str(target)

    msg = f"Generated {result['written']} files"
    if result["merged"]:
        msg += f" ({result['merged']} merged)"
    if result["conflicts"]:
        msg += f", {result['conflicts']} conflicts skipped"

    db.add(models.Activity(
        project_id=p.id, project_name=p.name, kind="generate", message=msg,
    ))
    db.commit()
    db.refresh(p)

    return {
        **result,
        "dryRun": False,
        "fileCount": len(files),
        "lines": p.lines_of_code,
        "report": export_report(
            target=target, plans=plans, files=files,
            written=result["written"], merged=result["merged"],
            skipped=result["skipped"], conflicts=result["conflicts"],
        ),
        "project": project_out(p),
    }


@router.get("/file")
def read_generated_file(pid: str, path: str = Query(...), db: Session = Depends(get_db)):
    """Return one rendered file's content (for the in-app preview)."""
    p, ctx = _ctx(db, pid)
    for f in _files_for(p, ctx):
        if f.path == path:
            return {"path": f.path, "content": f.content}
    raise HTTPException(status.HTTP_404_NOT_FOUND, f"{path} is not generated")


@router.get("/workspace")
def workspace_info(pid: str, db: Session = Depends(get_db)):
    p, ctx = _ctx(db, pid)
    target = resolve_target(p.path, ctx.slug)
    return {
        "default": str(default_workspace()),
        "target": str(target),
        "exists": target.exists(),
    }


# ── Phase 6: ZIP, diff, reveal ───────────────────────────
class ZipRequest(BaseModel):
    path: str | None = None          # None -> alongside the project folder
    includeRunScripts: bool = True


@router.post("/zip")
def export_zip(pid: str, body: ZipRequest, db: Session = Depends(get_db)):
    """Write a real .zip archive of the generated project."""
    p, ctx = _ctx(db, pid)
    files = _files_for(p, ctx, body.includeRunScripts)

    destination = Path(body.path).expanduser() if body.path else default_zip_path(ctx.slug)
    try:
        info = write_zip(files, destination, ctx.slug)
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Could not write archive: {exc}"
        ) from exc

    p.last_export_at = datetime.now(timezone.utc)
    db.add(models.Activity(
        project_id=p.id, project_name=p.name, kind="export",
        message=f"Exported ZIP ({info['bytes'] // 1024} KB, {info['files']} files)",
    ))
    db.commit()
    db.refresh(p)

    return {**info, "project": project_out(p)}


@router.get("/diff")
def diff_file(pid: str, path: str = Query(...), db: Session = Depends(get_db)):
    """Unified diff for one file: what's on disk vs what would be written."""
    p, ctx = _ctx(db, pid)
    files = _files_for(p, ctx)
    target = resolve_target(p.path, ctx.slug)

    plan = next((pl for pl in build_plan(files, target) if pl.path == path), None)
    if plan is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{path} is not generated")

    return file_diff(target, plan)


class RevealRequest(BaseModel):
    path: str | None = None


@router.post("/reveal")
def reveal(pid: str, body: RevealRequest, db: Session = Depends(get_db)):
    """Open the output folder (or a specific file) in the OS file manager."""
    p, ctx = _ctx(db, pid)
    target = Path(body.path).expanduser() if body.path else resolve_target(p.path, ctx.slug)

    if not target.exists():
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Nothing to open yet — generate the project first.",
        )
    return {"opened": reveal_in_explorer(target), "path": str(target)}
