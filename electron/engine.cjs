/**
 * Python sidecar supervisor.
 *
 * Dev  : runs engine/.venv/bin/python -m app.main
 * Prod : runs the PyInstaller binary shipped in resources/engine/
 */
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
let engineToken = null;

let child = null;
let chosenPort = null;

function findFreePort(start = 8731, tries = 40) {
  return new Promise((resolve, reject) => {
    let port = start;
    const attempt = () => {
      if (port > start + tries) return reject(new Error('no free port'));
      const srv = net.createServer();
      srv.once('error', () => { port += 1; attempt(); });
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '127.0.0.1');
    };
    attempt();
  });
}

function resolveInterpreter(rootDir) {
  const win = process.platform === 'win32';
  const venv = win
    ? path.join(rootDir, 'engine', '.venv', 'Scripts', 'python.exe')
    : path.join(rootDir, 'engine', '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return { cmd: venv, args: ['-m', 'app.main'], bundled: false };

  // No venv — fall back to whatever python is on PATH.
  return { cmd: win ? 'python' : 'python3', args: ['-m', 'app.main'], bundled: false };
}

/**
 * Find the engine inside a packaged build.
 *
 * Two shapes are supported, checked in this order:
 *
 *   1. A frozen single executable (PyInstaller) at
 *      `resources/engine/skaffo-engine.exe`. Preferred: one file, no
 *      interpreter for the user to install.
 *
 *   2. An embedded CPython at `resources/python/python.exe` running the
 *      engine sources from `resources/engine/`. Used when freezing is not
 *      practical, and keeps the Python readable for anyone who wants to look.
 *
 * Returning null means "not packaged" and the caller falls back to a dev venv.
 */
function resolveBundled(resourcesPath) {
  if (!resourcesPath) return null;
  const win = process.platform === 'win32';

  const frozen = path.join(resourcesPath, 'engine',
    win ? 'skaffo-engine.exe' : 'skaffo-engine');
  if (fs.existsSync(frozen)) return { cmd: frozen, args: [], bundled: true };

  const embedded = path.join(resourcesPath, 'python', win ? 'python.exe' : 'bin/python3');
  const sources = path.join(resourcesPath, 'engine', 'app', 'main.py');
  if (fs.existsSync(embedded) && fs.existsSync(sources)) {
    return {
      cmd: embedded,
      args: ['-m', 'app.main'],
      bundled: true,
      cwd: path.join(resourcesPath, 'engine'),
    };
  }

  return null;
}

// Never sweep by command-line substring: app.main is a common module name,
// and process IDs found by a system-wide scan do not prove Skaffo ownership.
// Only the child handle created by this supervisor may be terminated.

/**
 * @returns {Promise<{port:number, mode:string}>}
 */
async function startEngine({ isDev, rootDir, resourcesPath, onLog }) {
  chosenPort = await findFreePort();

  const target = (!isDev && resolveBundled(resourcesPath)) || resolveInterpreter(rootDir);
  // The embedded-CPython layout needs cwd on the sources, not on python.exe,
  // so `-m app.main` resolves; resolveBundled says so explicitly when it does.
  const cwd = target.cwd
    || (target.bundled ? path.dirname(target.cmd) : path.join(rootDir, 'engine'));

  onLog?.(`[engine] ${target.cmd} (port ${chosenPort})`);

  engineToken = randomBytes(32).toString('hex');
  child = spawn(target.cmd, [...target.args, '--port', String(chosenPort)], {
    cwd,
    env: { ...process.env, PYTHONUNBUFFERED: '1', SKAFFO_PORT: String(chosenPort),
           SKAFFO_ENGINE_TOKEN: engineToken },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (d) => onLog?.(`[engine] ${String(d).trim()}`));
  child.stderr.on('data', (d) => onLog?.(`[engine!] ${String(d).trim()}`));
  const startedChild = child;
  child.on('exit', (code) => {
    if (child === startedChild) { child = null; chosenPort = null; engineToken = null; }
    onLog?.(`[engine] exited with code ${code}`);
  });
  child.on('error', (err) => onLog?.(`[engine!] spawn failed: ${err.message}`));
  child.on('close', () => {
    if (child === startedChild) { child = null; chosenPort = null; engineToken = null; }
  });

  return { port: chosenPort, mode: target.bundled ? 'bundled' : 'venv' };
}

function stopEngine() {
  if (!child) return;
  try {
    if (process.platform === 'win32') {
      // A synchronous, exact-PID stop also works during Electron's exit event.
      if (child.pid && child.exitCode === null) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'],
          { windowsHide: true, timeout: 5000 });
      }
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* already gone */ }
  child = null;
  chosenPort = null;
  engineToken = null;
}

const getPort = () => chosenPort;

async function requestEngine({ path: route, method = 'GET', body } = {}) {
  if (!chosenPort || !engineToken || typeof route !== 'string' ||
      !/^\/(?:api\/|health(?:\?|$))/.test(route) || route.startsWith('//') ||
      /[\\\x00-\x1f]/.test(route) || /(?:^|\/)(?:\.{1,2}|%2e|%2f)/i.test(route) ||
      route.length > 2048 ||
      !['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ||
      (body !== undefined && (typeof body !== 'string' || body.length > 2_000_000))) {
    throw new Error('Invalid engine request');
  }
  const response = await fetch(`http://127.0.0.1:${chosenPort}${route}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Skaffo-Token': engineToken },
    body, signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}

module.exports = { startEngine, stopEngine, getPort, requestEngine };
