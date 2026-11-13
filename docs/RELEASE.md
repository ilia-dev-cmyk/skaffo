# Building the Windows installer

```bat
npm run dist
```

That runs three steps in order:

1. `npm run build` — type-check and bundle the renderer into `dist/`
2. `npm run build:engine` — freeze the Python engine into one executable
3. `electron-builder --win` — produce `release/Skaffo-Setup-<package.json version>.exe`

The last published tag is `v1.0.0`; the source metadata is `1.1.0`.
Building locally does not change the published release.

Requires Node 18+, Python 3.10+, and a populated `engine/.venv`
(`setup-engine.bat`). PyInstaller is installed into that venv automatically.

---

## Why the engine is frozen

The installer bundles a **single frozen executable**, not an embeddable
CPython tree.

The embeddable distribution needs pip bootstrapped, a `._pth` file edited, and
site-packages copied in. Each of those fails quietly and differently across
Windows builds, and the failure surfaces as "the app opens but nothing loads" —
the worst kind of bug to debug remotely. A frozen exe either exists at
`resources/engine/skaffo-engine.exe` and runs, or does not exist, which
`engine.cjs` can check with one `fs.existsSync`.

### Hidden imports

PyInstaller's static analysis cannot see modules reached through strings.
Three groups matter here and are listed explicitly in `scripts/build-engine.py`:

| Group | Why it is invisible |
|---|---|
| `uvicorn.protocols.*`, `uvicorn.loops.*`, `uvicorn.lifespan.*` | uvicorn selects them by name from its config |
| `sqlalchemy.dialects.sqlite` | chosen from the database URL scheme at runtime |
| `pydantic.deprecated.decorator` | imported lazily inside pydantic |

Missing any of these produces a binary that **starts and then dies on the
first request**. That is why the build script does not stop at "the file
exists" — it launches the binary and:

- calls `/health`
- creates a project (exercises SQLAlchemy and the sqlite dialect)
- renders a generation preview (proves the Jinja templates were bundled)

If any step fails the build aborts rather than shipping a broken installer.

### The entry point

`launch.py` exists because `app/main.py` uses relative imports (`from .core…`),
which only resolve when it runs as part of the `app` package. Freezing the
module directly strips that context and the binary dies immediately with
`ImportError: attempted relative import with no known parent package`.
`launch.py` imports `app.main` properly and calls the same `run()` the dev path
uses, so the frozen and source paths cannot drift.

---

## The icon

```bat
npm run build:icon
```

`build/icon.svg` is the source of truth. The script renders it through
**Chromium**, not ImageMagick: the ImageMagick build in CI has no SVG delegate
and silently flattens the artwork to a black circle — a file is produced, so
nothing looks wrong until you see it.

Two workarounds are baked in and commented in the script:

- A window smaller than roughly 30px is clamped by the platform, so the SVG is
  rasterised once at 512 and downscaled with `nativeImage.resize()`.
- A large transparent window segfaults Chromium under headless X, so the page
  is painted on a chroma-key green and `scripts/dekey.py` converts that to real
  alpha afterwards, verifying `corner alpha == 0` and `centre alpha == 255` for
  every size.

Outputs: `build/icon.ico` (7 sizes, 16→256), `build/icon.png` (1024) and
`build/icons/*.png` for Linux.

---

## Installer behaviour

| Setting | Value | Reason |
|---|---|---|
| `oneClick` | `false` | The user picks the install folder instead of it appearing somewhere |
| `perMachine` | `false` | Installs per-user, so there is no UAC prompt |
| `deleteAppDataOnUninstall` | `false` | **Uninstalling must never delete someone's projects** |
| `createDesktopShortcut` | `true` | |
| `runAfterFinish` | `true` | |

### It is not code-signed

A code-signing certificate is an annual cost, and Skaffo is free. So on first
download Windows SmartScreen will show *"Windows protected your PC"* until the
file accumulates reputation.

This is stated plainly in the README rather than hidden — telling users to
click through a security warning without explaining why is how people learn to
ignore security warnings.

---

## Verifying a build

The bundled engine must be what actually starts. Checking that the app opens
is not enough: on a developer machine it will happily fall back to a Python on
`PATH` and look fine.

The check that matters is to remove Python and try again:

```bash
# Linux/macOS equivalent of the check run before release
mkdir -p /tmp/nopy && ln -sf /bin/false /tmp/nopy/python3
PATH=/tmp/nopy:/usr/bin:/bin release/linux-unpacked/skaffo
```

Then confirm the process list shows the bundled path:

```
resources/engine/skaffo-engine --port 8731
```

and that `curl http://127.0.0.1:8731/health` answers. Verified before release:

```
[engine] .../resources/engine/skaffo-engine (port 8731)
[main] engine bundled on port 8731
{"status":"ok","app":"Skaffo Engine","version":"0.2.0", ...}
```

---

## Release checklist

- [ ] `xvfb-run -a npm run audit:app` (Linux) → all checks pass
- [ ] `cd engine && .venv\Scripts\python -m pytest tests\ -q` → all pass
- [ ] `node scripts/test-github.cjs` and `node scripts/test-security.cjs` → pass
- [ ] `npm run dist` → installer builds, engine smoke test passes
- [ ] Install on a machine with **no Python**, confirm it starts
- [ ] Delete `%APPDATA%\Skaffo`, launch, confirm the welcome screen appears once
- [ ] Uninstall, confirm `%APPDATA%\Skaffo` still holds the projects
- [ ] Tag and attach `Skaffo-Setup-<version>.exe` to a GitHub release
