"""Generator plugin contract.

Rule of the project: a generator is a PURE function.
    context in  ->  list[GeneratedFile] out
It never touches the disk. Only the writer does.
"""
from __future__ import annotations

import keyword
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from jinja2 import Environment, FileSystemLoader, StrictUndefined

from .escaping import flatten, register_filters

TEMPLATE_ROOT = Path(__file__).parent / "templates"

# ── identifier hardening ─────────────────────────────────
# Table/column names reach the filesystem (models/<name>.py) and the
# generated source. They can come from the UI *or* from an imported
# database (Phase 4), so treat every one of them as untrusted input.

_UNSAFE = re.compile(r"[^0-9a-zA-Z_]+")
_RESERVED = {"con", "prn", "aux", "nul", "clock$"} | {
    f"{p}{i}" for p in ("com", "lpt") for i in range(1, 10)
}


class UnsafeIdentifier(ValueError):
    """Raised when a name cannot be reduced to a safe identifier."""


def safe_identifier(raw: str, *, fallback: str = "table") -> str:
    """Reduce an arbitrary name to a bare, filesystem-safe identifier.

    Strips path separators, traversal sequences, and anything that is not
    ``[0-9a-zA-Z_]``. The result can never contain ``/``, ``\\``, ``..``,
    a drive letter, or a leading dot.

        "../../../etc/passwd"  -> "etc_passwd"
        "my-table"             -> "my_table"
        "C:\\evil"             -> "c_evil"
    """
    name = _UNSAFE.sub("_", str(raw)).strip("_").lower()

    if not name:
        raise UnsafeIdentifier(f"{raw!r} contains no usable characters")
    if name[0].isdigit():
        name = f"{fallback}_{name}"
    if name in _RESERVED or keyword.iskeyword(name):
        name = f"{name}_"

    # paranoia: the regex already guarantees this, but assert it anyway
    if "/" in name or "\\" in name or ".." in name or name in (".", ".."):
        raise UnsafeIdentifier(f"{raw!r} could not be made safe")

    return name


def project_slug(raw: str) -> str:
    """Reduce a project display name to a single safe directory segment.

    SECURITY-003. This is the *one* definition of a project slug. It used to
    be duplicated in ``routers/projects.py`` as a bare
    ``name.lower().replace(" ", "-")``, which preserved ``/`` and ``..`` — so
    a project named ``../../../tmp/x`` was stored as
    ``~/Projects/../../../tmp/x`` and the export wrote outside the workspace.

        "My Shop"              -> "my-shop"
        "../../../tmp/x"       -> "tmp-x"
        "My Shop$(id)"         -> "my-shop-id"
        "..";  ""              -> "project"
    """
    cleaned = re.sub(r"[^0-9a-zA-Z_-]+", "-", str(raw).strip().lower())
    cleaned = cleaned.strip("-._")
    # A slug is a single path segment: never a separator, never a traversal.
    if not cleaned or set(cleaned) <= {"-", ".", "_"}:
        return "project"
    if cleaned in _RESERVED:
        return f"{cleaned}-project"
    return cleaned


def safe_relpath(path: str) -> str:
    """Validate a generated file path stays relative and contained."""
    p = str(path).replace("\\", "/")
    parts = p.split("/")
    if (not p or p.startswith("/") or any(
        not part or part in (".", "..") or ":" in part or "\x00" in part
        or part.endswith((".", " ")) or part.lower().split(".")[0] in _RESERVED
        for part in parts
    )):
        raise UnsafeIdentifier(f"unsafe generated path: {path!r}")
    return p


@dataclass(frozen=True)
class GeneratedFile:
    path: str          # POSIX relative path, e.g. "backend/app/main.py"
    content: str
    executable: bool = False

    def __post_init__(self):
        # Chokepoint: every generated file is validated on construction,
        # so a plugin cannot emit a traversing path even by accident.
        object.__setattr__(self, "path", safe_relpath(self.path))


@dataclass
class GenContext:
    """Everything a generator is allowed to know."""
    project: dict                      # serialized Project
    tables: list[dict] = field(default_factory=list)
    relations: list[dict] = field(default_factory=list)
    endpoints: list[dict] = field(default_factory=list)
    crud_options: dict = field(default_factory=dict)

    @property
    def name(self) -> str:
        return self.project["name"]

    @property
    def slug(self) -> str:
        """Directory-safe project slug (never traverses)."""
        return project_slug(self.project["name"])

    @property
    def snake(self) -> str:
        return safe_identifier(self.slug, fallback="project")

    @property
    def stack(self) -> dict:
        return self.project["stack"]

    @property
    def auth(self) -> str:
        return self.stack.get("auth", "none")

    @property
    def docker(self) -> bool:
        return bool(self.stack.get("docker"))

    @property
    def seed_enabled(self) -> bool:
        """Whether to emit `backend/app/seed.py` with sample rows."""
        return bool(self.stack.get("seedData"))

    @property
    def seed_rows(self) -> int:
        try:
            return int(self.stack.get("seedRows") or 12)
        except (TypeError, ValueError):
            return 12


class Generator(Protocol):
    id: str
    name: str

    def generate(self, ctx: GenContext) -> list[GeneratedFile]: ...


# ── Jinja environment ────────────────────────────────────
# Custom delimiters: templates emit Python/JS/Vue code that is full of
# {{ }} and {% %}. Using <% %> keeps generated output untouched.
def make_env(subdir: str) -> Environment:
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATE_ROOT / subdir)),
        block_start_string="<%",
        block_end_string="%>",
        variable_start_string="@@",
        variable_end_string="@@",
        comment_start_string="<#",
        comment_end_string="#>",
        trim_blocks=True,
        lstrip_blocks=True,
        keep_trailing_newline=True,
        undefined=StrictUndefined,
    )
    # All name filters run through safe_identifier first: their output lands
    # in class names and file paths, so untrusted input must not survive.
    env.filters["pascal"] = lambda s: "".join(p.title() for p in safe_identifier(s).split("_"))
    env.filters["camel"] = lambda s: (
        lambda w: w[0] + "".join(p.title() for p in w[1:])
    )(safe_identifier(s).split("_"))
    env.filters["snake"] = lambda s: safe_identifier(s)
    env.filters["singular"] = lambda s: str(s)[:-1] if str(s).endswith("s") else str(s)
    # SECURITY-002: free-text values (the project display name) are not
    # identifiers and never pass through safe_identifier. Templates must
    # escape them for the language they are writing into.
    register_filters(env)
    return env


# ── type mapping ─────────────────────────────────────────
SQLA_TYPES = {
    "integer": "Integer", "bigint": "BigInteger", "string": "String(255)",
    "text": "Text", "boolean": "Boolean", "float": "Float",
    "decimal": "Numeric(12, 2)", "datetime": "DateTime", "date": "Date",
    "uuid": "String(36)", "json": "JSON",
}

PY_TYPES = {
    "integer": "int", "bigint": "int", "string": "str", "text": "str",
    "boolean": "bool", "float": "float", "decimal": "Decimal",
    "datetime": "datetime", "date": "date", "uuid": "str", "json": "dict",
}

TS_TYPES = {
    "integer": "number", "bigint": "number", "string": "string", "text": "string",
    "boolean": "boolean", "float": "number", "decimal": "number",
    "datetime": "string", "date": "string", "uuid": "string", "json": "unknown",
}


def sqla_type(t: str) -> str:
    return SQLA_TYPES.get(t, "String(255)")


def py_type(t: str) -> str:
    return PY_TYPES.get(t, "str")


def ts_type(t: str) -> str:
    return TS_TYPES.get(t, "string")


def py_default(col: dict) -> str | None:
    """Translate a UI default into Python source."""
    dv = col.get("defaultValue")
    if dv in (None, ""):
        return None
    low = str(dv).strip().lower()
    if low in ("now()", "current_timestamp"):
        return "datetime.utcnow"
    if low in ("true", "false"):
        return low.capitalize()
    if str(dv).startswith("'") and str(dv).endswith("'"):
        return f'"{str(dv)[1:-1]}"'
    try:
        float(dv)
        return str(dv)
    except ValueError:
        return f'"{dv}"'
