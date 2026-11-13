/**
 * Screenshot harness — drives the real built app and captures the README shots.
 *
 *   xvfb-run -a node_modules/.bin/electron scripts/shoot.cjs
 *
 * Deliberately drives the *production* bundle (dist/) against a real engine,
 * so what lands in the README is what a user actually sees.
 *
 * Skaffo ships with an empty workspace, so this script creates its own demo
 * project through the real API first. That is closer to the truth than a
 * seeded fixture: the screenshots show a project built the same way a user
 * would build one.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { startEngine, stopEngine, getPort, requestEngine } = require('../electron/engine.cjs');
const secrets = require('../electron/secrets.cjs');
const github = require('../electron/github.cjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const W = 1500, H = 940;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win, port, errors = [];

// Same IPC surface main.cjs exposes, so the publish dialog is real.
const TOKEN_KEY = 'github.token';
ipcMain.handle('gh:status', async () => ({
  ...secrets.describe(TOKEN_KEY), gitInstalled: await github.gitAvailable(),
}));
ipcMain.handle('gh:save-token', async () => ({ ok: false, error: 'demo' }));
ipcMain.handle('gh:use-session-token', async () => ({ ok: false, error: 'demo' }));
ipcMain.handle('gh:forget-token', () => true);
ipcMain.handle('gh:publish', async () => ({ ok: false, error: 'demo' }));
ipcMain.handle('win:minimize', () => {});
ipcMain.handle('win:maximize', () => false);
ipcMain.handle('win:close', () => {});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:platform', () => process.platform);
ipcMain.handle('engine:port', () => getPort());
ipcMain.handle('engine:request', (_event, options) => requestEngine(options));

async function settle(extra = 0) {
  // Two rAFs: capturePage() can otherwise grab a stale compositor frame.
  await win.webContents.executeJavaScript(
    `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`);
  if (extra) await sleep(extra);
}

async function shoot(name, wait = 800) {
  await sleep(wait);
  await settle(200);
  fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG());
  console.log(`  ✓ ${name} (${(fs.statSync(path.join(OUT, name)).size / 1024).toFixed(0)} KB)`);
}

const js = (code) => win.webContents.executeJavaScript(code);

/** Click by visible text, retrying until it lands. */
async function click(label, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const hit = await js(`(() => {
      const e = [...document.querySelectorAll('button,a,[role="button"],[role="tab"]')]
        .find(x => (x.textContent||'').trim().startsWith(${JSON.stringify(label)}));
      if (e && !e.disabled) {
        e.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
        return true;
      }
      return false; })()`);
    if (hit) { await settle(280); return true; }
    await sleep(190);
  }
  console.log(`  ! missed "${label}"`);
  return false;
}

async function reload() {
  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await sleep(2600);
}

/** Build a demo project through the HTTP API, exactly as the UI would. */
async function createDemoProject() {
  const post = async (p, body, method = 'POST') => {
    const r = await requestEngine({ path: p, method, body: JSON.stringify(body) });
    if (r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };

  const existing = (await requestEngine({ path: '/api/projects' })).data;
  if (existing.length) return existing[0].id;

  const project = await post('/api/projects', {
    name: 'My Shop',
    description: 'Storefront API — users, products and orders',
    stack: { backend: 'fastapi', frontend: 'react', database: 'sqlite',
             auth: 'jwt', docker: true, seedData: true, seedRows: 12 },
  });

  const col = (name, type, o = {}) => ({
    name, type, primaryKey: !!o.pk, nullable: !!o.nullable,
    unique: !!o.unique, defaultValue: o.def ?? null,
  });

  await post(`/api/projects/${project.id}/schema`, {
    tables: [
      { id: 't1', name: 'users', color: '#6366F1', position: { x: 60, y: 60 }, columns: [
        col('id', 'integer', { pk: true }),
        col('email', 'string', { unique: true }),
        col('password', 'string'),
        col('full_name', 'string', { nullable: true }),
        col('is_active', 'boolean', { def: 'true' }),
        col('created_at', 'datetime', { def: 'now()' }),
      ]},
      { id: 't2', name: 'products', color: '#10B981', position: { x: 470, y: 40 }, columns: [
        col('id', 'integer', { pk: true }),
        col('title', 'string'),
        col('slug', 'string', { unique: true }),
        col('description', 'text', { nullable: true }),
        col('price', 'decimal'),
        col('stock', 'integer', { def: '0' }),
        col('created_at', 'datetime', { def: 'now()' }),
      ]},
      { id: 't3', name: 'orders', color: '#7C3AED', position: { x: 265, y: 400 }, columns: [
        col('id', 'integer', { pk: true }),
        col('user_id', 'integer'),
        col('product_id', 'integer'),
        col('quantity', 'integer', { def: '1' }),
        col('total', 'decimal'),
        col('status', 'string', { def: "'pending'" }),
        col('created_at', 'datetime', { def: 'now()' }),
      ]},
    ],
    relations: [
      { kind: 'one-to-many', fromTableId: 't1', fromColumnIndex: 0,
        toTableId: 't3', toColumnIndex: 1, onDelete: 'cascade' },
      { kind: 'one-to-many', fromTableId: 't2', fromColumnIndex: 0,
        toTableId: 't3', toColumnIndex: 2, onDelete: 'restrict' },
    ],
  }, 'PUT');

  // Real CRUD endpoints, so the API and OpenAPI screens have content.
  // Not swallowed: a silent failure here produced an empty API screenshot.
  for (const entity of ['users', 'products', 'orders']) {
    await post(`/api/projects/${project.id}/api/generate/${entity}`, {});
  }
  return project.id;
}

async function openProject() {
  return js(`(() => {
    const c = [...document.querySelectorAll('*')].find(e =>
      (e.textContent||'').trim() === 'My Shop' &&
      e.closest('[class*="cursor-pointer"],button,a'));
    const t = c && c.closest('[class*="cursor-pointer"],button,a');
    if (t) t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return !!t; })()`);
}

async function setLocale(label) {
  await click('Settings') || await click('تنظیمات');
  await sleep(1000);
  await js(`(() => {
    const t = [...document.querySelectorAll('button,[role="button"]')]
      .find(e => (e.textContent||'').trim().startsWith(${JSON.stringify(label)}));
    if (t) t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return !!t; })()`);
  await sleep(1100);
}

async function setTheme(label) {
  await js(`(() => {
    const t = [...document.querySelectorAll('button,[role="button"]')]
      .find(e => (e.textContent||'').trim().startsWith(${JSON.stringify(label)}));
    if (t) t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return !!t; })()`);
  await sleep(900);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const started = await startEngine({
    isDev: true, rootDir: ROOT, resourcesPath: process.resourcesPath,
    onLog: (m) => { if (/error|traceback/i.test(m)) console.log(m); },
  });
  port = started.port ?? getPort();
  console.log(`engine on ${port}`);

  win = new BrowserWindow({
    width: W, height: H, show: true, backgroundColor: '#0F172A', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: [`--skaffo-port=${port}`],
    },
  });
  win.webContents.on('console-message', (_e, lv, m) => {
    if (lv >= 2 && !/DevTools|Autofill|GPU stall/i.test(m)) errors.push(m);
  });

  // ── 1. the empty first-run dashboard (no sample project exists) ──
  await reload();
  console.log('\ncapturing…');
  await shoot('00-empty-dashboard.png', 1000);

  // ── build a demo project the same way a user would ──
  const pid = await createDemoProject();
  console.log(`  demo project ${pid}`);
  await reload();

  await shoot('01-dashboard.png', 1100);

  await click('Projects');  await shoot('03-projects.png', 1300);
  await click('Templates'); await shoot('04-templates.png', 1300);

  await click('Dashboard'); await sleep(900);
  await openProject(); await sleep(1600);

  if (await click('Database')) {
    await sleep(1900);
    await shoot('05-database.png', 600);
    await js(`(() => { const n = document.querySelector('.react-flow__node');
      if (n) n.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      return 1; })()`);
    await shoot('06-database-inspector.png', 1200);
  }

  if (await click('API')) {
    await shoot('07-api.png', 1500);
    for (const label of ['OpenAPI', 'Spec']) if (await click(label)) break;
    await shoot('11-openapi.png', 1600);
    await js(`(() => { const b=[...document.querySelectorAll('button')]
      .find(e=>!(e.textContent||'').trim() && e.closest('[class*="fixed"]'));
      if(b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      return 1; })()`);
    await sleep(700);
  }

  if (await click('Export')) {
    await shoot('08-export.png', 1600);
    await click('Dry run'); await shoot('12-export-diff.png', 2400);
    await reload(); await openProject(); await sleep(1500);
    await click('Export'); await sleep(1500);
    await click('GitHub Repository'); await shoot('19-export-github.png', 1100);
    await click('Create & push'); await shoot('20-publish-dialog.png', 1300);
    await reload(); await openProject(); await sleep(1400);
  }

  if (await click('Support')) await shoot('17-support.png', 1300);
  if (await click('Settings')) await shoot('09-settings.png', 1100);

  await setTheme('Light'); await shoot('13-theme-light.png', 800);
  await setTheme('Nord');  await shoot('14-theme-nord.png', 800);
  await setTheme('Dark');

  // ── wizard, including the sample-data toggle ──
  await reload();
  await click('Create Project'); await sleep(1400);
  await js(`(() => { const i=document.querySelector('input');
    if(i){ const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      s.call(i,'Blog API'); i.dispatchEvent(new Event('input',{bubbles:true})); }
    return !!i; })()`);
  await sleep(500);
  await shoot('10-wizard-step1.png', 700);
  for (let i = 0; i < 6; i++) { await click('Next'); await sleep(430); }
  await shoot('18-wizard-seed.png', 900);

  // ── Persian RTL ──
  await reload();
  await setLocale('فارسی');
  await shoot('15-rtl-persian.png', 1200);
  await openProject(); await sleep(1400);
  if (await click('دیتابیس')) await shoot('16-rtl-database.png', 2000);
  await setLocale('English');

  console.log('\nerrors:', errors.length ? errors : 'none');
  stopEngine();
  app.quit();
}

app.whenReady().then(main).catch((e) => {
  console.error('FATAL', e);
  stopEngine();
  app.exit(1);
});
