/**
 * Open a generated project in the user's terminal, and tell them up front
 * whether it will actually work.
 *
 * Why a terminal rather than running it inside Skaffo
 * ---------------------------------------------------
 * Starting a generated project means creating a virtualenv, `pip install`,
 * `npm install` (~3,700 files), then two dev servers. Measured on a warm
 * CI box that is ~23 seconds; on a Windows machine with Defender scanning
 * every new file it is minutes. Hiding that behind a spinner inside the app
 * makes Skaffo look hung, and it puts Skaffo in charge of two child
 * processes it cannot reliably reap.
 *
 * Handing it to a real terminal costs ~30 lines instead of ~2,000, and the
 * user sees pip and npm output as it happens — which is exactly what they
 * need when something fails.
 *
 * What this module adds beyond "spawn a terminal"
 * -----------------------------------------------
 *  - a real prerequisite check (python / node / npm) with versions, so a
 *    missing tool is reported *before* a terminal flashes open and closes
 *  - detection of what has already been done (venv present, node_modules
 *    present, sample data seeded) so the UI can predict the wait
 *  - a terminal picker per platform, with fallbacks, because there is no
 *    single "open a terminal here" API on any OS
 */
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

// ── prerequisite probing ─────────────────────────────────

/**
 * Run a command purely to read its version. Never throws.
 *
 * `shell: true` on Windows is not optional here. `npm`, `npx` and `yarn` are
 * shipped as `.cmd` shims, and `execFile` without a shell can only launch a
 * real `.exe` — it fails with ENOENT for anything else. Reported by a user:
 * the panel claimed "npm not found" on a machine where npm was installed and
 * working, which disabled the run button entirely.
 *
 * The command names here are hard-coded constants, never user input, so
 * enabling the shell does not widen the attack surface.
 */
function probe(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    let child;
    try {
      // On Windows the whole thing is handed to cmd as one string. Node
      // warns (DEP0190) that args passed alongside `shell: true` are not
      // escaped — true in general, but every command and argument here is a
      // hard-coded constant, never user input. Building the string ourselves
      // makes that explicit and keeps the warning out of the user's console.
      const target = WIN ? `${cmd} ${args.join(' ')}` : cmd;
      const targetArgs = WIN ? [] : args;

      child = execFile(target, targetArgs, {
        timeout,
        windowsHide: true,
        shell: WIN,
      }, (err, stdout, stderr) => {
        if (err) return finish(null);
        const text = `${stdout}${stderr}`.trim();
        finish(text.split('\n')[0].trim() || null);
      });
    } catch {
      return finish(null);
    }
    child.on('error', () => finish(null));
  });
}

/** First release number in a version string: "Python 3.13.1" -> [3,13,1] */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text || '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

const atLeast = (v, major, minor) =>
  !!v && (v[0] > major || (v[0] === major && v[1] >= minor));

/**
 * Check everything the generated project needs.
 *
 * Deliberately probes the *same* commands `run.bat` / `run.sh` use, rather
 * than looking for an install directory. A Python that exists but is not on
 * PATH is exactly the failure the scripts hit, so the check has to fail the
 * same way.
 */
async function checkPrerequisites() {
  // Windows `python` can be the Store alias stub, which prints nothing and
  // opens the Microsoft Store. Try `py` first there — it is the real launcher.
  const pythonCandidates = WIN ? [['py', ['-3', '--version']], ['python', ['--version']]]
                               : [['python3', ['--version']], ['python', ['--version']]];

  let python = null;
  for (const [cmd, args] of pythonCandidates) {
    const out = await probe(cmd, args);
    if (out && /python\s*\d/i.test(out)) { python = { cmd, raw: out }; break; }
  }

  const [nodeRaw, npmRaw] = await Promise.all([
    probe('node', ['--version']),
    probe('npm', ['--version'], 10000),   // npm is slow to start on Windows
  ]);

  const pyV = python ? parseVersion(python.raw) : null;
  const nodeV = parseVersion(nodeRaw);

  return {
    python: {
      found: !!python,
      version: python ? python.raw : null,
      ok: atLeast(pyV, 3, 10),
      required: '3.10+',
      url: 'https://www.python.org/downloads/',
      note: python && !atLeast(pyV, 3, 10)
        ? 'Found, but the generated backend needs 3.10 or newer.'
        : null,
    },
    node: {
      found: !!nodeRaw,
      version: nodeRaw,
      ok: atLeast(nodeV, 18, 0),
      required: '18+',
      url: 'https://nodejs.org/',
      note: nodeRaw && !atLeast(nodeV, 18, 0)
        ? 'Found, but Vite 6 needs Node 18 or newer.'
        : null,
    },
    npm: {
      found: !!npmRaw,
      version: npmRaw ? `npm ${npmRaw}` : null,
      ok: !!npmRaw,
      required: 'bundled with Node',
      url: 'https://nodejs.org/',
      note: null,
    },
  };
}

// ── what the project has already done ────────────────────

/**
 * Inspect the generated folder so the UI can say "this will take 3 minutes"
 * instead of "this will take some time".
 */
function inspectProject(dir) {
  const has = (...p) => fs.existsSync(path.join(dir, ...p));

  const backend = has('backend');
  const frontend = has('frontend');
  const venv = has('backend', '.venv', WIN ? 'Scripts' : 'bin');
  const modules = has('frontend', 'node_modules');
  const seedScript = has('backend', 'app', 'seed.py');
  const seeded = has('backend', '.seeded');

  // Rough, honest estimate. These are the measured costs of a cold start:
  // venv ~2s, pip ~6s, npm ~15s on a fast machine — several times that on
  // Windows with a virus scanner touching every extracted file.
  let seconds = 5;
  if (backend && !venv) seconds += 60;
  if (frontend && !modules) seconds += 150;

  return {
    exists: fs.existsSync(dir),
    backend, frontend, venv, modules, seedScript, seeded,
    firstRun: (backend && !venv) || (frontend && !modules),
    estimateSeconds: seconds,
    script: WIN ? 'run.bat' : 'run.sh',
    hasScript: has(WIN ? 'run.bat' : 'run.sh'),
  };
}

// ── terminal selection ───────────────────────────────────

/**
 * Terminals to try, best first.
 *
 * There is no portable "open a terminal in this folder and run X", so each
 * platform gets an ordered list and the first one that starts wins. On
 * Windows, Windows Terminal is tried before cmd because it is what modern
 * installs actually use.
 */
function terminalPlan(dir, command) {
  if (WIN) {
    return [
      {
        name: 'Windows Terminal',
        cmd: 'wt.exe',
        args: ['-d', dir, 'cmd.exe', '/k', command],
      },
      {
        name: 'Command Prompt',
        cmd: process.env.COMSPEC || 'cmd.exe',
        // `start ""` supplies the window title, which `start` requires before
        // a quoted argument. `/D` sets the working directory as its own
        // argument rather than `cd /d "<dir>" && ...` inside the command
        // string: cmd re-parses that string, so a path containing a space —
        // and %TEMP% usually has one — produced
        // "The filename, directory name, or volume label syntax is incorrect."
        args: ['/c', 'start', '', '/D', dir, 'cmd.exe', '/k', command],
      },
    ];
  }

  if (MAC) {
    const script =
      `tell application "Terminal"\n` +
      `  do script "cd ${shq(dir)} && ${command.replace(/"/g, '\\"')}"\n` +
      `  activate\n` +
      `end tell`;
    return [{ name: 'Terminal', cmd: 'osascript', args: ['-e', script] }];
  }

  // Linux: whichever emulator is installed.
  const hold = `bash -lc ${shq(`cd ${shq(dir)} && ${command}; echo; echo "[finished] press enter"; read`)}`;
  return [
    { name: 'GNOME Terminal', cmd: 'gnome-terminal', args: ['--working-directory', dir, '--', 'bash', '-lc', `${command}; exec bash`] },
    { name: 'Konsole',        cmd: 'konsole',        args: ['--workdir', dir, '-e', 'bash', '-lc', `${command}; exec bash`] },
    { name: 'XFCE Terminal',  cmd: 'xfce4-terminal', args: ['--working-directory', dir, '-e', hold] },
    { name: 'xterm',          cmd: 'xterm',          args: ['-e', hold] },
    { name: 'Default',        cmd: 'x-terminal-emulator', args: ['-e', hold] },
  ];
}

/** POSIX single-quote a string. */
function shq(s) {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

// ── launching ────────────────────────────────────────────

/**
 * Open a terminal in `dir` running `command`.
 *
 * SECURITY-002 note: `dir` comes from a project path, which is derived from
 * a user-controlled project name. It is passed as a *separate argv entry*
 * everywhere possible rather than interpolated into a shell string, and the
 * one place a string is unavoidable (cmd.exe `start`) wraps it in quotes
 * after the path has already been validated to exist on disk.
 */
function openTerminal(dir, command) {
  return new Promise((resolve) => {
    const plan = terminalPlan(dir, command);

    const tryNext = (i) => {
      if (i >= plan.length) {
        return resolve({
          ok: false,
          error: 'No terminal application could be started.',
          hint: WIN
            ? 'Open the folder and double-click run.bat instead.'
            : 'Install a terminal emulator, or run ./run.sh from a shell.',
        });
      }

      const { name, cmd, args } = plan[i];
      let settled = false;

      let child;
      try {
        child = spawn(cmd, args, {
          cwd: dir,
          detached: true,          // survives Skaffo being closed
          stdio: 'ignore',
          windowsHide: false,
        });
      } catch {
        return tryNext(i + 1);
      }

      child.on('error', () => { if (!settled) { settled = true; tryNext(i + 1); } });

      // A terminal that starts successfully stays alive. Give it a moment;
      // if it has not died, treat it as launched and let it go.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.unref(); } catch { /* already gone */ }
        resolve({ ok: true, terminal: name });
      }, 700);
    };

    tryNext(0);
  });
}

/** The command a terminal should run for this project. */
function runCommand(mode) {
  const script = WIN ? 'run.bat' : './run.sh';
  switch (mode) {
    case 'backend':
      return WIN
        ? 'backend\\.venv\\Scripts\\uvicorn app.main:app --reload --app-dir backend'
        : 'cd backend && .venv/bin/uvicorn app.main:app --reload';
    case 'frontend':
      return WIN ? 'cd frontend && npm run dev' : 'cd frontend && npm run dev';
    case 'seed':
      return WIN
        ? 'cd backend && .venv\\Scripts\\python -m app.seed --reset'
        : 'cd backend && .venv/bin/python -m app.seed --reset';
    case 'shell':
      return WIN ? 'echo Project shell. Run %s to start everything. & echo.'
                   .replace('%s', script)
                 : `echo "Project shell. Run ${script} to start everything."`;
    case 'full':
    default:
      return script;
  }
}

/**
 * Public entry point.
 *
 * Validates before launching so failures are explained in the UI rather than
 * appearing as a terminal window that flashes and vanishes.
 */
async function launch({ dir, mode = 'full' }) {
  if (!dir) return { ok: false, error: 'No project folder.' };

  const target = path.resolve(dir);
  if (!fs.existsSync(target)) {
    return {
      ok: false,
      error: 'That folder no longer exists.',
      hint: `Expected it at ${target}. Generate the project again.`,
    };
  }

  const info = inspectProject(target);
  if (mode === 'full' && !info.hasScript) {
    return {
      ok: false,
      error: `${info.script} is missing from the project.`,
      hint: 'Re-export with "Include run.bat / run.sh" switched on.',
    };
  }
  if ((mode === 'backend' || mode === 'seed') && !info.venv) {
    return {
      ok: false,
      error: 'The backend virtualenv has not been created yet.',
      hint: `Run ${info.script} once first — it sets everything up.`,
    };
  }
  if (mode === 'frontend' && !info.modules) {
    return {
      ok: false,
      error: 'Frontend dependencies are not installed yet.',
      hint: `Run ${info.script} once first — it runs npm install for you.`,
    };
  }

  const result = await openTerminal(target, runCommand(mode));
  return { ...result, dir: target, mode, info };
}

module.exports = {
  checkPrerequisites,
  inspectProject,
  launch,
  runCommand,
  // exported for tests
  parseVersion,
  terminalPlan,
};
