const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { startEngine, stopEngine, getPort, requestEngine } = require('./engine.cjs');
const { isSafeExternal, isTrustedFrame, isKnownProjectDir } = require('./security.cjs');
const secrets = require('./secrets.cjs');
const github = require('./github.cjs');
const launcher = require('./launcher.cjs');

const isDev = !app.isPackaged;
const DEV_URL = 'http://localhost:5273';
const ROOT = path.join(__dirname, '..');

/** @type {BrowserWindow | null} */
let win = null;
let enginePort = null;
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0F172A',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--skaffo-port=${enginePort ?? 8731}`],
    },
  });

  win.once('ready-to-show', () => win && win.show());

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  win.on('closed', () => { win = null; });
}

// Reject IPC from navigated documents and subframes (including embedded content).
const handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
  if (!win || !isTrustedFrame(event.senderFrame, win.webContents.mainFrame, isDev, ROOT)) {
    throw new Error('Untrusted IPC sender');
  }
  return listener(event, ...args);
});

handle('engine:request', (_event, options) => requestEngine(options));

// Renderer paths may only refer to an existing project output that the engine
// has recorded after generation. In particular, openPath must never accept
// an arbitrary executable file and publish must not stage an arbitrary folder.
async function approvedOutput(dir) {
  try {
    const { data } = await requestEngine({ path: '/api/projects' });
    return isKnownProjectDir(dir, data);
  } catch { return false; }
}

// ── window controls ──
handle('win:minimize', () => win && win.minimize());
handle('win:maximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
handle('win:close', () => win && win.close());
handle('app:version', () => app.getVersion());
handle('app:platform', () => process.platform);
handle('engine:port', () => getPort());

// ── Run the generated project ──
// Everything here is main-process only: the renderer can ask "can this run?"
// and "open a terminal", but never gets to name a command.
handle('run:check', async () => {
  try {
    return { ok: true, ...(await launcher.checkPrerequisites()) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

handle('run:inspect', async (_e, dir) => {
  try {
    if (!fs.existsSync(String(dir || ''))) {
      return { ok: true, ...launcher.inspectProject(String(dir || '')) };
    }
    if (!(await approvedOutput(dir))) return { ok: false, error: 'Not a generated project folder.' };
    return { ok: true, ...launcher.inspectProject(dir) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

handle('run:launch', async (_e, options) => {
  // `mode` is validated against a fixed list rather than trusted, so the
  // renderer cannot smuggle a command through it (SECURITY-002).
  const allowed = new Set(['full', 'backend', 'frontend', 'seed', 'shell']);
  const mode = allowed.has(options && options.mode) ? options.mode : 'full';
  try {
    const dir = options && options.dir;
    if (typeof dir === 'string' && !fs.existsSync(dir)) {
      return launcher.launch({ dir, mode }); // preserve the missing-folder hint
    }
    if (!(await approvedOutput(dir))) return { ok: false, error: 'Not a generated project folder.' };
    return await launcher.launch({ dir, mode });
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

handle('run:open-folder', async (_e, dir) => {
  if (!(await approvedOutput(dir))) return { ok: false, error: 'Not a generated project folder.' };
  const err = await shell.openPath(dir);
  return err ? { ok: false, error: err } : { ok: true };
});

// ── GitHub publishing ──
// The token never crosses into the renderer. The UI can save it, ask whether
// one is saved, and trigger a publish — but `getSecret` is only ever called
// here, in the main process.
const TOKEN_KEY = 'github.token';

handle('gh:status', async () => ({
  ...secrets.describe(TOKEN_KEY),
  gitInstalled: await github.gitAvailable(),
}));

handle('gh:save-token', async (_e, token) => {
  const clean = String(token || '').trim();
  if (!clean) return { ok: false, error: 'Token is empty.' };
  try {
    // Verify before storing, so a typo is caught immediately rather than
    // at push time with a confusing git error.
    const user = await github.verifyToken(clean);
    const stored = secrets.setSecret(TOKEN_KEY, clean);
    return {
      ok: true,
      user,
      persisted: stored,
      warning: stored ? null
        : 'Your OS keychain is unavailable, so the token was not saved to disk. It will be kept for this session only.',
    };
  } catch (err) {
    // Keep it in memory for this session even if we cannot persist it.
    return { ok: false, error: err.message, hint: err.hint || null };
  }
});

handle('gh:forget-token', () => {
  sessionToken = null;
  return secrets.deleteSecret(TOKEN_KEY);
});

// Fallback when the OS keystore is missing (some Linux desktops).
let sessionToken = null;
handle('gh:use-session-token', async (_e, token) => {
  const clean = String(token || '').trim();
  try {
    const user = await github.verifyToken(clean);
    sessionToken = clean;
    return { ok: true, user, persisted: false };
  } catch (err) {
    return { ok: false, error: err.message, hint: err.hint || null };
  }
});

handle('gh:publish', async (event, options) => {
  if (!(await approvedOutput(options && options.dir))) {
    return { ok: false, error: 'Not a generated project folder.' };
  }
  const token = secrets.getSecret(TOKEN_KEY) || sessionToken;
  if (!token) {
    return { ok: false, error: 'No GitHub token saved.',
             hint: 'Add a personal access token first.' };
  }
  try {
    const result = await github.publish({
      token,
      dir: options.dir,
      name: options.name,
      description: options.description,
      isPrivate: options.isPrivate,
      onStep: (step) => {
        if (!event.sender.isDestroyed()) event.sender.send('gh:progress', step);
      },
    });
    return { ok: true, ...result };
  } catch (err) {
    return {
      ok: false,
      // Defence in depth: redact again on the way out, in case an error
      // message from git or the API echoed the token back.
      error: github.redact(err.message, token),
      hint: err.hint ? github.redact(err.hint, token) : null,
    };
  }
});

app.whenReady().then(async () => {
  if (!hasInstanceLock) return;
  try {
    const info = await startEngine({
      isDev,
      rootDir: ROOT,
      resourcesPath: process.resourcesPath,
      onLog: (line) => console.log(line),
    });
    enginePort = info.port;
    console.log(`[main] engine ${info.mode} on port ${info.port}`);
  } catch (err) {
    console.error('[main] engine failed to start:', err);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', stopEngine);
app.on('will-quit', stopEngine);
process.on('exit', stopEngine);

app.on('window-all-closed', () => {
  stopEngine();
  if (process.platform !== 'darwin') app.quit();
});
