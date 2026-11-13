# Security and maintenance notes (unreleased changes on this branch)

The historical reports [SECURITY-FIX-001](SECURITY-FIX-001.md) and
[SECURITY-FIX-002](SECURITY-FIX-002.md) describe earlier fixes. This document
records the additional issues confirmed in the current code and their scope.

| Confirmed behavior before this change | Mitigation |
|---|---|
| Writer rejected `/etc` but allowed `/etc/subdir` and other protected descendants. Windows drive paths were interpreted as workspace-relative paths on POSIX. | Component-aware forbidden-tree checks, platform-aware path parsing, path validation both while planning and writing. |
| A generated path or ZIP destination could name a symlink. `Path.resolve()` proved where it pointed *at that instant*, but writes followed it. | Reject symlink entries and recheck after parent creation. Reject Windows-special path components, system-directory ZIP targets, and ZIP roots with multiple segments. |
| `pkill -f 'app.main --port'` / PowerShell command-line matching could select unrelated Python processes with the same module name. | No process-wide sweep. Stop only the spawned child (and on Windows, its own process tree). |
| `start /D <dir>` re-parsed Windows paths containing `%`, quotes and metacharacters; macOS assembled an AppleScript string with a shell-quoted path but without AppleScript escaping. | Detached `cmd.exe` uses `cwd`; macOS passes the path as an `osascript` argument and uses `quoted form of` for the terminal shell. |
| `shell.openExternal` accepted arbitrary URL schemes; `run:open-folder` could open an arbitrary executable, and publish/launch accepted arbitrary folders from renderer IPC. | Allow only HTTP(S) external links; only operate on existing, recorded generated-project directories; block navigation, gate IPC to the expected main frame and enable renderer sandboxing. |
| CORS headers by themselves did not prevent cross-site writes to the unauthenticated loopback engine. | Validate Host/Origin and give Electron-launched engines a random per-launch token held in the main process. The renderer uses a bounded IPC request proxy; the token is never returned to it. |

## Scope and residual risks

- The engine binds to `127.0.0.1` by default. When started by Electron it
  requires the per-launch token even for reads. Standalone `npm run engine`
  deliberately has **no token** (browser-only `npm run dev:web` and CLI users
  need to connect); it rejects unexpected Host and Origin headers but local
  processes running as the same OS user can still access its data. Do not bind
  the standalone server to a network interface on an untrusted machine.
- An already compromised main process or same-user process that can read the
  sidecar's environment may obtain the token. The proxy does not turn a
  compromised renderer into a trusted application; legitimate generation,
  reveal, terminal and GitHub operations are still exposed to the UI.
- Symlink checks are re-run immediately before each file write but are not
  atomic against a concurrent process replacing directories between check
  and open. Fully race-free writes would require platform-specific handle-
  relative filesystem APIs. Windows junction behavior needs manual testing.
- A crashed sidecar may remain until OS cleanup. We intentionally do not
  kill processes merely because their command line resembles ours; no
  ownership-proof mechanism survives a parent crash in this version.
- The CSP still allows inline styles and localhost connections for the
  browser development mode. It no longer permits inline JavaScript.
- These changes have not been manually verified on Windows or macOS in the
  development environment. The Windows CI job covers Python path rules and
  terminal argv construction, not a GUI launch or installer.

## Reproduce checks

```bash
python -m compileall -q engine/app engine/tests
cd engine && .venv/bin/python -m pytest tests/ -q
node scripts/test-security.cjs
node scripts/test-engine-integration.cjs  # needs engine/.venv
node scripts/test-launcher.cjs
node scripts/test-github.cjs
npm run build
xvfb-run -a npm run audit:app    # Linux with Electron/Xvfb available
```

If you discover an issue, please avoid publishing exploitable details until
maintainers can assess it; use GitHub's private vulnerability reporting when
available. Do not include tokens, project databases or private output files.
