const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { isSafeExternal, isTrustedFrame, isKnownProjectDir } = require('../electron/security.cjs');
const engine = require('../electron/engine.cjs');

let passed = 0;
async function check(name, test) {
  await test();
  passed++;
  console.log(`  ✓ ${name}`);
}

// Load the same launcher on simulated OSes; test the actual argv plans rather
// than trying to execute osascript or cmd.exe on a Linux runner.
function launcherFor(platform) {
  const file = path.join(__dirname, '../electron/launcher.cjs');
  const context = { require, module: { exports: {} }, process: {
    platform, env: process.env,
  }, setTimeout };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.module.exports;
}

(async () => {
  await check('rejects external file, script, credential and custom schemes', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x',
                       'ftp://example.org/', 'https://user:pass@example.org/']) {
      assert.equal(isSafeExternal(url), false);
    }
    assert.equal(isSafeExternal('https://github.com/project'), true);
    assert.equal(isSafeExternal('http://localhost:5173'), true);
  });

  await check('IPC sender must be the current main frame at its expected URL', () => {
    const root = '/tmp/app';
    const frame = { url: require('node:url').pathToFileURL(path.join(root, 'dist/index.html')).href };
    assert.equal(isTrustedFrame(frame, frame, false, root), true);
    assert.equal(isTrustedFrame({ url: frame.url }, frame, false, root), false);
    frame.url = 'https://example.org/';
    assert.equal(isTrustedFrame(frame, frame, false, root), false);
    frame.url = 'http://localhost:5273/';
    assert.equal(isTrustedFrame(frame, frame, true, root), true);
    frame.url = 'http://evil.local:5273/';
    assert.equal(isTrustedFrame(frame, frame, true, root), false);
  });

  await check('only an existing generated directory can be opened, run or published', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skaffo-approved-'));
    const project = path.join(root, 'output');
    const privateDir = path.join(root, 'private');
    fs.mkdirSync(project);
    fs.mkdirSync(privateDir);
    fs.writeFileSync(path.join(root, 'file.sh'), 'echo unsafe');
    const known = [{ path: project }];
    try {
      assert(isKnownProjectDir(project, known));
      assert(!isKnownProjectDir(privateDir, known));
      assert(!isKnownProjectDir(path.join(root, 'file.sh'), [{ path: path.join(root, 'file.sh') }]));
      assert(!isKnownProjectDir(path.join(project, '..', 'private'), known));
      assert(!isKnownProjectDir(path.join(root, 'missing'), [{ path: path.join(root, 'missing') }]));
      const link = path.join(root, 'link');
      try {
        fs.symlinkSync(privateDir, link, 'dir');
        assert(!isKnownProjectDir(link, [{ path: link }]));
      } catch (error) {
        if (error.code !== 'EPERM') throw error;
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  const hostile = '/tmp/sp ace/quo\'te"/$(touch PWNED);%TEMP%\\new';
  await check('Windows cmd fallback never passes the directory to a shell parser', () => {
    const plan = launcherFor('win32').terminalPlan(hostile, 'run.bat');
    assert.equal(plan[0].args[1], hostile);
    assert.deepEqual(Array.from(plan[1].args), ['/k', 'run.bat']);
    assert(!plan[1].args.some((arg) => arg.includes(hostile)));
  });

  await check('macOS keeps the hostile path out of AppleScript source', () => {
    const plan = launcherFor('darwin').terminalPlan(hostile, './run.sh')[0];
    assert.equal(plan.cmd, 'osascript');
    assert.equal(plan.args.at(-2), hostile);
    assert.equal(plan.args.at(-1), './run.sh');
    assert(!plan.args[1].includes(hostile));
    assert(plan.args[1].includes('quoted form of (item 1 of argv)'));
    const quoted = launcherFor('darwin').terminalPlan(hostile,
      'echo "Project shell"')[0];
    assert.equal(quoted.args.at(-1), 'echo "Project shell"');
    assert(!quoted.args[1].includes('Project shell'));
  });

  await check('Linux fallback shell starts in a quoted hostile directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skaffo '$(touch PWNED) "));
    try {
      // xfce/xterm fallback contains a shell command; run it with stdin closed
      // and observe a file written inside the intended working directory.
      const plan = launcherFor('linux').terminalPlan(dir, 'printf safe > result.txt');
      const hold = plan.find((entry) => entry.name === 'xterm').args[1];
      const r = spawnSync('bash', ['-lc', hold], { cwd: os.tmpdir(), timeout: 3000 });
      // `read` receives EOF in this non-interactive harness; the actual
      // command must still have run in the intended directory.
      assert.equal(r.status, 1, String(r.stderr));
      assert.equal(fs.readFileSync(path.join(dir, 'result.txt'), 'utf8'), 'safe');
      assert(!fs.existsSync(path.join(os.tmpdir(), 'PWNED')));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  if (process.platform !== 'win32') {
    await check('starting and stopping the sidecar does not terminate other Python processes', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skaffo-supervisor-'));
      const bin = path.join(root, 'engine', '.venv', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'python'), '#!/bin/sh\nexec sleep 20\n', { mode: 0o755 });
      const other = spawn('python3', ['-c', 'import time; time.sleep(20)', 'app.main --port'],
        { stdio: 'ignore' });
      try {
        await engine.startEngine({ isDev: true, rootDir: root });
        assert.equal(other.exitCode, null, 'unrelated Python process was killed');
        engine.stopEngine();
        assert.equal(other.exitCode, null, 'stopping the sidecar killed another process');
      } finally {
        engine.stopEngine(); other.kill();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  await check('engine proxy refuses non-engine URLs and commands', async () => {
    for (const options of [{ path: '//evil.example' }, { path: '/docs' },
                           { path: '/api/projects', method: 'TRACE' },
                           { path: '/api/../../etc' }]) {
      await assert.rejects(engine.requestEngine(options), /Invalid engine request/);
    }
  });

  console.log(`\n${passed} passed, 0 failed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
