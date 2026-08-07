# 🚀 Skaffo

**Design your database and API visually — get a real, runnable FastAPI + React project.**

Not a mockup generator. Skaffo writes actual source code to disk: SQLAlchemy models,
Pydantic schemas, FastAPI routers, Alembic migrations, a React + TypeScript frontend,
and pytest tests that pass.

> **Free and open source.** Every feature is unlocked — no paid tier, no account,
> no telemetry. Your projects never leave your machine.
>
> Formerly *CodeForge Studio*; renamed to **Skaffo** in v0.8.

![Skaffo in 30 seconds](docs/demo.gif)

<sub>Real screen capture, no edits — schema to 69 generated files.</sub>

---

## ▶️ Run it

### Install (Windows)

Download **`Skaffo-Setup.exe`** from the
[latest release](https://github.com/ilia-dev-cmyk/skaffo/releases) and run it.
Python and Node are **not** required — the engine ships inside the installer.

> Skaffo is not code-signed (a certificate costs money and this is free), so
> Windows SmartScreen shows *"Windows protected your PC"* the first time.
> Click **More info → Run anyway**. You can verify what you are running:
> the whole source is in this repository.

### Or run from source

**Requirements:** [Node.js 18+](https://nodejs.org) and [Python 3.10+](https://python.org)
(on Windows, tick *"Add Python to PATH"* during install).

```bash
git clone https://github.com/ilia-dev-cmyk/skaffo.git
cd skaffo
npm install

# once — creates the Python virtualenv for the engine
setup-engine.bat        # Windows
./setup-engine.sh       # macOS / Linux

npm run dev             # Vite + Electron + Python engine
```

Other scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Vite + Electron + Python engine (hot reload) |
| `npm run dev:web` | Browser + engine, http://localhost:5273 |
| `npm run engine` | Python API only — docs at http://127.0.0.1:8731/docs |
| `npm run build` | Type-check + production bundle into `dist/` |
| `npm run electron` | Launch Electron against the built `dist/` |
| `npm run dist` | Build the Windows installer into `release/` |
| `npm run build:engine` | Freeze the Python engine into one executable |
| `npm run build:icon` | Regenerate the icon set from `build/icon.svg` |

### Running the tests

The engine's runtime dependencies are kept separate from its test
dependencies, so users who only run the app do not download a test framework:

```bash
cd engine
.venv\Scripts\pip install -r requirements-dev.txt   # Windows
.venv/bin/pip install -r requirements-dev.txt        # macOS / Linux

.venv\Scripts\python -m pytest tests\ -q            # Windows
.venv/bin/python -m pytest tests/ -q                 # macOS / Linux
```

```bash
node scripts/test-github.cjs    # GitHub publishing, against a fake API
node scripts/test-launcher.cjs  # terminal launching, against a fake terminal (22)
```

There is also a full end-to-end audit that launches the real app against a
scratch data directory and clicks through every screen — 77 checks covering
the empty first run, the wizard, the designer canvas, DDL for all three
dialects, OpenAPI, dry-run containment, seed-data quality, the publish
dialog, all four themes, RTL, persistence across restart, and delete:

```bash
xvfb-run -a node_modules/.bin/electron scripts/audit.cjs   # Linux/CI
node_modules\.bin\electron scripts\audit.cjs              # Windows
```

> If you see `The system cannot find the path specified`, the virtualenv does
> not exist yet — run `setup-engine.bat` (or `./setup-engine.sh`) first.
> `.venv/` is intentionally not committed.

**On Windows:** a handful of tests prove that a hostile project name cannot
execute a command, by running the generated `run.sh` through a real shell.
Windows ships a `bash.exe` that is only a WSL launcher stub, so the suite
probes for a genuine shell — including the one bundled with Git for Windows —
and reports which it found in the pytest header. If none is usable those
tests are skipped with the reason printed, rather than failing misleadingly.

---

## ✅ What works right now

Everything below is implemented, tested and shipping — **not planned, not stubbed.**

| Area | What you get |
|---|---|
| **Database Designer** | React Flow canvas, drag tables, PK/FK icons, drag-to-connect relations, column inspector (type, nullable, unique, default), rename / duplicate / delete |
| **Validation** | 20 rules, including relation cycle detection, orphan FKs and duplicate names |
| **SQL export** | SQLite · PostgreSQL · MySQL DDL, topologically sorted so it runs top-to-bottom |
| **Schema import** | Read an existing `.db` file, or paste raw `CREATE TABLE` SQL |
| **Undo / Redo** | Full schema snapshots, `Ctrl+Z` / `Ctrl+Shift+Z`, written back atomically |
| **API Designer** | CRUD generation per entity, custom endpoint editor, query-feature toggles, live code preview |
| **OpenAPI 3.1** | Live spec preview, validated against the official `openapi-spec-validator` |
| **Project Generator** | Real FastAPI + React project on disk — models, schemas, routers, Alembic migrations, tests, `run.bat` / `run.sh` |
| **Re-generate / Sync** | Protected regions (`skaffo:keep`) survive regeneration; conflicts are reported, never silently overwritten |
| **Sample data** | A `seed.py` with believable rows — `email` looks like an email, `price` looks like money, foreign keys point at rows that exist |
| **Publish to GitHub** | Create a repository and push, with the token held by your OS keychain — never by Skaffo |
| **Export** | Write to folder or real ZIP (deflate), **dry run**, per-file diffs, export report, Open Folder |
| **Run it** | Checks Python/Node versions, predicts the first-run wait, then opens your terminal — five modes: everything, API only, frontend only, reseed, or just a shell |
| **Themes** | Dark · Light · Midnight · Nord, all via CSS variables |
| **Languages** | 8 locales (en · fa · ar · es · de · fr · tr · zh) with real RTL layout |
| **Accessibility** | Reduce-motion toggle, keyboard-only focus rings |
| **Persistence** | FastAPI sidecar + SQLite, auto-spawned by Electron — nothing is in-memory |
| **Empty by default** | No sample project is installed; every counter starts at zero and only shows your own work |
| **One-file install** | The Windows installer bundles the Python engine — users need neither Python nor Node |

**Quality:** 286 passing Python tests · TypeScript clean (`tsc --noEmit`) ·
zero console errors in a headless Electron run · 65 KB initial JS bundle (20 KB gzipped).

---

## 🏗 Architecture — the main rule

> **Every part must be independent (plugin-based).**

```
src/
├─ core/                  ← the only shared layer
│  ├─ types.ts            Schema, Project, Plugin contract
│  ├─ registry.ts         PluginRegistry + event bus
│  ├─ store.ts            Zustand — single source of truth, undo/redo
│  ├─ api.ts              typed client for the Python engine
│  ├─ theme.ts            4 themes as CSS variables
│  └─ i18n.ts             8 locales + RTL
├─ ui/                    design system (Card, Button, Sidebar, Topbar…)
├─ plugins/               ← every feature is a plugin
│  ├─ dashboard/
│  ├─ projects/
│  ├─ templates/
│  ├─ database/           Database Designer
│  ├─ api/                API Designer
│  ├─ export/             Export Engine
│  ├─ settings/
│  ├─ support/
│  ├─ wizard/
│  └─ index.ts            registration only
└─ App.tsx                shell + lazy router

electron/
├─ main.cjs               window, IPC, custom titlebar
├─ preload.cjs            contextBridge — no nodeIntegration
└─ engine.cjs             spawns the Python sidecar, kills orphans, finds a free port

engine/                   FastAPI + SQLAlchemy + SQLite
├─ app/routers/           projects · schema · schema_tools · api_design · generate
├─ app/services/          validate · ddl · openapi_spec · export · serialize
├─ app/generator/         pure generators + 50 Jinja templates
└─ tests/                 286 tests
```

**The contract every generator must satisfy:**

```ts
interface SkaffoPlugin {
  id: string;
  capabilities: ('generator' | 'designer' | 'exporter' | 'template')[];
  generate?(ctx: ProjectContext): Promise<GeneratedFile[]>;
}
```

A generator is a **pure function**: context in, `GeneratedFile[]` out. It never touches disk.
Only the Export Engine writes files — which is why preview, dry-run and ZIP come for free.

No plugin imports another plugin. They only know `@core`.

---

## 🔒 Security

Anything that reaches generated code is treated as untrusted input — table and
column names can come from an imported database, and a project's display name
is free text.

- **Path traversal** is blocked at four layers: identifier sanitising,
  `GeneratedFile` construction, containment checks in the writer, and a
  forbidden-target guard — [`docs/SECURITY-FIX-001.md`](docs/SECURITY-FIX-001.md)
- **Command / code injection** — the project name is escaped per destination
  language (shell, batch, Python, HTML, JSX, Markdown) rather than by a
  character blocklist, because a single "sanitised" string cannot be safe in
  five grammars at once — [`docs/SECURITY-FIX-002.md`](docs/SECURITY-FIX-002.md)
- **Your GitHub token** is stored by the OS keychain (DPAPI / Keychain /
  libsecret), never in Skaffo's database, never in `.git/config`, never in a
  process argument, and never readable by the UI layer —
  [`docs/SEED-AND-GITHUB.md`](docs/SEED-AND-GITHUB.md)

132 of the 286 tests are security regression tests, and they assert on
behaviour: shell payloads are executed in a real `bash`, generated Python is
parsed with `ast`. Both issues were reported by a user reading the source.

---

## 📸 Screens

**Skaffo starts empty.** No sample project, no fake numbers — the workspace is
yours from the first launch.

![First run](docs/screenshots/00-empty-dashboard.png)

**Database Designer** — drag tables, drag-to-connect foreign keys, live validation.

![Database Designer](docs/screenshots/06-database-inspector.png)

**Export** — pick a format, dry-run it, see every file before anything is written.

![Export](docs/screenshots/08-export.png)

| | |
|---|---|
| ![API Designer](docs/screenshots/07-api.png) | ![OpenAPI 3.1](docs/screenshots/11-openapi.png) |
| **API Designer** — CRUD + custom endpoints | **OpenAPI 3.1** — live, spec-validated |
| ![Light theme](docs/screenshots/13-theme-light.png) | ![Nord theme](docs/screenshots/14-theme-nord.png) |
| **Light** | **Nord** |
| ![RTL Persian](docs/screenshots/15-rtl-persian.png) | ![RTL canvas](docs/screenshots/16-rtl-database.png) |
| **Persian** — the whole layout mirrors | **RTL canvas** — the diagram stays LTR |
| ![Templates](docs/screenshots/04-templates.png) | ![Support](docs/screenshots/17-support.png) |
| **Templates** | **Support** — optional, nothing is gated |
| ![Dashboard](docs/screenshots/01-dashboard.png) | ![Sample data](docs/screenshots/18-wizard-seed.png) |
| **Dashboard** | **Sample data** — on by default |
| ![Publish to GitHub](docs/screenshots/20-publish-dialog.png) | ![Export diff](docs/screenshots/12-export-diff.png) |
| **Publish** — token stays in the OS keychain | **Dry run** — see every change before writing |

---

## 🗺 Build order

- [x] **Phase 1** — Electron + React shell, all screens
- [x] **Phase 2** — FastAPI sidecar + SQLite persistence
- [x] **Phase 3** — Project Generator + **Re-generate / Sync**
- [x] **Phase 4** — Validation · SQL export · Import · Undo/Redo
- [x] **Phase 5** — Custom endpoints · OpenAPI · generated tests
- [x] **Phase 6** — ZIP · dry run · diffs · run scripts
- [x] **v0.7** — 4 themes · 8 languages · RTL · code-split bundle
- [x] **v0.9** — Renamed to Skaffo · everything free · Support page
- [x] **v0.9.1** — Injection hardening (SECURITY-002 / 003)
- [x] **v0.10** — Sample data · publish to GitHub · empty first run
- [x] **v1.0** — Windows installer · app icon · first-run welcome
- [x] **v1.1** — Run in terminal, with prerequisite checks ← **you are here**
- [ ] **v1.1** — Auto-update · command palette · in-app editor

Decisions and risks behind this order: [`docs/REVIEW.md`](docs/REVIEW.md).
How releases are built and verified: [`docs/RELEASE.md`](docs/RELEASE.md).
How to test the Run panel by hand: [`docs/TESTING-v1.1.md`](docs/TESTING-v1.1.md).

---

## 🔒 Locked into v1 scope

FastAPI · React · SQLite. Every other stack option is visible but marked *Soon* —
deliberately. One stack done properly beats eight done halfway.

---

## 🎨 Design system

| Token | Value |
|---|---|
| Background | `#0F172A` |
| Sidebar | `#111827` |
| Primary | `#6366F1` |
| Hover | `#7C3AED` |
| Success | `#10B981` |
| Danger | `#EF4444` |
| Card | `#1E293B` |
| Text | `#F8FAFC` |

Font **Inter** (+ JetBrains Mono for code) · Icons **Lucide React** ·
Animations fade / slide / scale @ **200ms** · every colour is a CSS variable, so
themes swap with no re-render.

---

## 💬 Questions, bugs, ideas

- 🐛 Something broken? [Open an issue](https://github.com/ilia-dev-cmyk/skaffo/issues)
- 💡 Idea or question? [Start a discussion](https://github.com/ilia-dev-cmyk/skaffo/discussions)

---

## 📄 License

MIT — see [`LICENSE`](LICENSE).

---

## ☕ Support

Skaffo is free and stays free. If it saved you time:

⭐ Star the repo · 🐛 Report a bug · 🔗 Tell a friend

Crypto donations are welcome but entirely optional — see
[`docs/SUPPORT.md`](docs/SUPPORT.md).
