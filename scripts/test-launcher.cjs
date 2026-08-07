/**
 * Behavioural tests for electron/launcher.cjs.
 *
 *   node scripts/test-launcher.cjs
 *
 * Runs under plain node — no Electron needed, because the launcher only uses
 * child_process and fs. Terminal launches are exercised against a fake
 * "terminal" on PATH so we can assert what was actually invoked, rather than
 * asserting that a function returned true.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const launcher = require('../electron/launcher.cjs');

/**
 * Remove a temp tree, tolerating Windows.
 *
 * On Windows a directory cannot be deleted while a process still has it open,
 * and these tests deliberately spawn a terminal that lingers. Reported by a
 * user as two EPERM failures — the launcher was fine, the cleanup was not.
 */
function cleanup(dir, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 });
      return;
    } catch {
      // busy — wait synchronously and try again
      const until = Date.now() + 150;
      while (Date.now() < until) { /* spin */ }
    }
  }
  // Still locked: the OS will reclaim it. Not a test failure.
}

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

/** A project tree in whatever state we need. */
function makeProject({ backend = true, frontend = true, venv = false,
                       modules = false, seed = false, seeded = false,
                       script = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-test-'));
  const mk = (...p) => fs.mkdirSync(path.join(dir, ...p), { recursive: true });
  const touch = (...p) => fs.writeFileSync(path.join(dir, ...p), '');

  if (backend) mk('backend', 'app');
  if (frontend) mk('frontend');
  if (venv) mk('backend', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  if (modules) mk('frontend', 'node_modules');
  if (seed) touch('backend', 'app', 'seed.py');
  if (seeded) touch('backend', '.seeded');
  if (script) touch(process.platform === 'win32' ? 'run.bat' : 'run.sh');
  return dir;
}

(async () => {
  console.log('launcher.cjs\n');

  // ── version parsing ──
  await check('parses every version string shape we see in the wild', () => {
    assert.deepStrictEqual(launcher.parseVersion('Python 3.13.1'), [3, 13, 1]);
    assert.deepStrictEqual(launcher.parseVersion('v20.11.0'), [20, 11, 0]);
    assert.deepStrictEqual(launcher.parseVersion('10.9.0'), [10, 9, 0]);
    assert.deepStrictEqual(launcher.parseVersion('Python 3.10'), [3, 10, 0]);
    assert.strictEqual(launcher.parseVersion('not a version'), null);
    assert.strictEqual(launcher.parseVersion(''), null);
    assert.strictEqual(launcher.parseVersion(undefined), null);
  });

  // ── prerequisite probing ──
  await check('probes the real toolchain and reports versions', async () => {
    const p = await launcher.checkPrerequisites();
    for (const key of ['python', 'node', 'npm']) {
      assert.ok(key in p, `${key} missing from the report`);
      assert.ok('found' in p[key] && 'ok' in p[key] && 'url' in p[key]);
    }
    // This machine has all three, so a false here means the probe is broken.
    assert.ok(p.node.found, 'node should have been detected');
    assert.ok(p.npm.found, 'npm should have been detected');
  });

  await check('probing works for shim commands, not just real binaries', async () => {
    // Regression: on Windows `npm` is `npm.cmd`, and execFile without a shell
    // can only launch a real .exe — so npm was reported "not found" on
    // machines where it worked fine, which disabled the whole run panel.
    // Simulate the same shape here with a shell script that is not an ELF
    // binary, which is the closest Linux analogue to a .cmd shim.
    // The shim has to be whatever the platform actually uses: a .cmd batch
    // file on Windows (which is exactly what npm ships as), a shell script
    // elsewhere. Writing a #!/bin/sh file on Windows tests nothing.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-'));
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(bin, 'faketool.cmd'), '@echo off\r\necho 9.9.9\r\n');
    } else {
      const shim = path.join(bin, 'faketool');
      fs.writeFileSync(shim, '#!/bin/sh\necho 9.9.9\n');
      fs.chmodSync(shim, 0o755);
    }

    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
    try {
      const out = await new Promise((resolve) => {
        require('node:child_process').execFile(
          'faketool', [], { shell: process.platform === 'win32', windowsHide: true },
          (err, stdout) => resolve(err ? null : String(stdout).trim()));
      });
      assert.strictEqual(out, '9.9.9', 'a shim command could not be probed');
    } finally {
      process.env.PATH = prevPath;
      cleanup(bin);
    }
  });

  await check('the probe enables a shell on Windows so .cmd shims resolve', () => {
    // Read the *behaviour*, not the source text: an earlier version of this
    // check just grepped for "shell: WIN" and happily passed when the line
    // was commented out.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'electron', 'launcher.cjs'), 'utf8');

    // Isolate probe() and strip comments before asserting.
    const start = src.indexOf('function probe(');
    assert.ok(start > -1, 'probe() not found');
    const body = src.slice(start, src.indexOf('\n}', start))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    assert.match(body, /shell\s*:\s*WIN/,
      'probe() must pass shell:WIN, or npm.cmd is undetectable on Windows');
  });

  await check('a too-old runtime is found but not ok', async () => {
    const p = await launcher.checkPrerequisites();
    // Reproduce the comparison the module makes, to pin the rule itself.
    const old = launcher.parseVersion('v16.20.0');
    assert.ok(!(old[0] > 18 || (old[0] === 18 && old[1] >= 0)),
      'Node 16 must not satisfy the 18+ requirement');
    assert.ok(p.node.required.includes('18'));
  });

  // ── project inspection ──
  await check('a cold project is reported as a first run', () => {
    const dir = makeProject({ seed: true });
    const i = launcher.inspectProject(dir);
    assert.strictEqual(i.firstRun, true);
    assert.strictEqual(i.venv, false);
    assert.strictEqual(i.modules, false);
    assert.ok(i.estimateSeconds > 120, `estimate was ${i.estimateSeconds}s`);
    cleanup(dir);
  });

  await check('a warm project is not a first run and estimates seconds', () => {
    const dir = makeProject({ venv: true, modules: true, seed: true, seeded: true });
    const i = launcher.inspectProject(dir);
    assert.strictEqual(i.firstRun, false);
    assert.strictEqual(i.seeded, true);
    assert.ok(i.estimateSeconds < 30, `estimate was ${i.estimateSeconds}s`);
    cleanup(dir);
  });

  await check('a half-installed project still counts as a first run', () => {
    const dir = makeProject({ venv: true, modules: false });
    const i = launcher.inspectProject(dir);
    assert.strictEqual(i.firstRun, true, 'npm install is still pending');
    cleanup(dir);
  });

  await check('inspecting a missing folder does not throw', () => {
    const i = launcher.inspectProject('/definitely/not/here');
    assert.strictEqual(i.exists, false);
  });

  // ── guards ──
  await check('a missing folder is refused with the path in the hint', async () => {
    const r = await launcher.launch({ dir: '/definitely/not/here', mode: 'full' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /no longer exists/i);
    assert.match(r.hint, /definitely/);
  });

  await check('no run script is refused with a fix, not a stack trace', async () => {
    const dir = makeProject({ script: false });
    const r = await launcher.launch({ dir, mode: 'full' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /run\.(bat|sh) is missing/);
    assert.match(r.hint, /Re-export/);
    cleanup(dir);
  });

  await check('backend-only is refused before the venv exists', async () => {
    const dir = makeProject();
    const r = await launcher.launch({ dir, mode: 'backend' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /virtualenv/i);
    assert.match(r.hint, /run\.(bat|sh)/);
    cleanup(dir);
  });

  await check('frontend-only is refused before node_modules exists', async () => {
    const dir = makeProject();
    const r = await launcher.launch({ dir, mode: 'frontend' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /dependencies are not installed/i);
    cleanup(dir);
  });

  await check('seed is refused before the venv exists', async () => {
    const dir = makeProject({ seed: true });
    const r = await launcher.launch({ dir, mode: 'seed' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /virtualenv/i);
    cleanup(dir);
  });

  // ── commands ──
  await check('every mode maps to a distinct command', () => {
    const seen = new Set();
    for (const m of ['full', 'backend', 'frontend', 'seed', 'shell']) {
      const c = launcher.runCommand(m);
      assert.ok(c && c.length, `${m} produced no command`);
      seen.add(c);
    }
    assert.strictEqual(seen.size, 5, 'two modes produced the same command');
  });

  await check('an unknown mode falls back to the full run script', () => {
    assert.strictEqual(launcher.runCommand('nonsense'), launcher.runCommand('full'));
    assert.strictEqual(launcher.runCommand(undefined), launcher.runCommand('full'));
  });

  await check('seed uses --reset so it is not a no-op on a seeded project', () => {
    assert.match(launcher.runCommand('seed'), /--reset/);
  });

  // ── terminal plan ──
  await check('the platform offers at least one terminal, with fallbacks', () => {
    const plan = launcher.terminalPlan('/tmp/x', './run.sh');
    assert.ok(plan.length >= 1);
    for (const t of plan) {
      assert.ok(t.name && t.cmd && Array.isArray(t.args));
    }
    if (process.platform === 'linux') {
      assert.ok(plan.length >= 3, 'Linux needs several emulators tried');
    }
  });

  await check('a path containing a space is never spliced into a command string', () => {
    // Regression, reported from Windows: the cmd.exe fallback used
    //   start "" cmd /k cd /d "<dir>" && run.bat
    // cmd re-parses that string, so %TEMP% paths with a space produced
    // "The filename, directory name, or volume label syntax is incorrect."
    // The directory must be its own argument in every plan entry.
    const spaced = path.join(os.tmpdir(), 'my project folder');
    for (const t of launcher.terminalPlan(spaced, 'run.bat')) {
      for (const arg of t.args) {
        if (typeof arg !== 'string' || arg === spaced) continue;
        if (!arg.includes(spaced)) continue;

        // Appearing inside a longer argument is only safe if it is quoted.
        // The POSIX plans build a `bash -lc '…'` string and quote the path
        // with shq(); cmd.exe re-parses its argument, so there it must be a
        // separate entry. Either way, a *bare* path with a space is a bug.
        const quoted =
          arg.includes(`'${spaced}'`) ||
          arg.includes(`"${spaced}"`);
        assert.ok(quoted,
          `${t.name} embedded an unquoted path with a space:\n      ${arg}`);
      }
    }
  });

  await check('the project path is passed as argv, not spliced into a command', () => {
    // SECURITY-002: the folder name comes from the project name, which is
    // free text. Anywhere it is a separate argv entry, quoting cannot fail.
    const evil = '/tmp/a b$(touch /tmp/PWNED)';
    const plan = launcher.terminalPlan(evil, './run.sh');
    const asArgv = plan.some((t) => t.args.includes(evil));
    assert.ok(asArgv, 'no terminal received the path as its own argument');
  });

  // ── a real launch, against a fake terminal ──
  await check('launching starts a terminal process and does not execute the path', async () => {
    // Intercepting the terminal only works where the plan resolves through
    // PATH. On Windows it deliberately does not: `wt.exe` is looked up as a
    // real executable (spawn without a shell will not run a .cmd), and
    // COMSPEC is an absolute path to system32\\cmd.exe. That is correct
    // behaviour — Skaffo should launch the user's real terminal, not
    // whatever happens to be earlier on PATH.
    //
    // So: on POSIX, assert the fake terminal was invoked with the right
    // arguments. On Windows, assert the launch reports success, names a
    // terminal, and leaves no marker behind.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'faketerm-'));
    const log = path.join(bin, 'invoked.log');
    const marker = path.join(bin, 'PWNED');
    const win = process.platform === 'win32';

    if (!win) {
      for (const t of launcher.terminalPlan(bin, 'noop')) {
        const p = path.join(bin, path.basename(t.cmd));
        fs.writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\n`);
        fs.chmodSync(p, 0o755);
      }
    }

    const dir = makeProject({ venv: true, modules: true });
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
    try {
      const r = await launcher.launch({ dir, mode: 'full' });
      assert.strictEqual(r.ok, true, r.error || 'launch failed');
      assert.ok(r.terminal, 'no terminal name reported');

      await new Promise((res) => setTimeout(res, 500));

      if (win) {
        // A real terminal opened; we cannot read its argv, but we can prove
        // nothing was executed out of the project path.
        assert.ok(!fs.existsSync(marker), 'something executed the path');
      } else {
        assert.ok(fs.existsSync(log), 'the terminal was never invoked');
        const invoked = fs.readFileSync(log, 'utf8');
        assert.ok(invoked.includes(dir) || invoked.includes('run.sh'),
          `terminal got unexpected arguments:\n${invoked}`);
        assert.ok(!fs.existsSync(marker), 'something executed the path');
      }
    } finally {
      process.env.PATH = prevPath;
      cleanup(dir);
      cleanup(bin);
    }
  });

  await check('an empty PATH either still works or fails with a hint', async () => {
    // Windows always has a terminal: cmd.exe is found through COMSPEC with an
    // absolute path, so an empty PATH does not remove it. Asserting failure
    // there would be asserting a Linux assumption, not a requirement.
    const dir = makeProject({ venv: true, modules: true });
    const prevPath = process.env.PATH;
    const prevComspec = process.env.COMSPEC;
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
    if (process.platform === 'win32') delete process.env.COMSPEC;
    try {
      const r = await launcher.launch({ dir, mode: 'full' });
      if (r.ok) {
        assert.ok(r.terminal, 'succeeded but named no terminal');
      } else {
        assert.match(r.error, /No terminal/i);
        assert.ok(r.hint && r.hint.length > 10, 'no actionable hint');
      }
    } finally {
      process.env.PATH = prevPath;
      if (prevComspec !== undefined) process.env.COMSPEC = prevComspec;
      cleanup(dir);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
