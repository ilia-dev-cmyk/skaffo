/**
 * Record the README demo by driving the real app.
 *
 *   xvfb-run -a -s "-screen 0 1500x940x24" node_modules/.bin/electron scripts/record-demo.cjs
 *
 * Captures PNG frames from a live Electron window — no mockups, no editing.
 * `scripts/make-gif.sh` then turns them into a GIF and an MP4.
 *
 * The story it tells, in order:
 *   1. empty workspace          "this is yours, nothing preinstalled"
 *   2. draw a schema            "the thing you actually came for"
 *   3. generate CRUD            "it understands the schema"
 *   4. OpenAPI                  "this is a real API, not a toy"
 *   5. export 50+ files         "it writes real code"
 *   6. the generated source     ← the payoff. Without this it is just a diagram tool.
 *
 * Frames are captured on a fixed cadence rather than "one per action", so the
 * result plays at a natural speed instead of jumping.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { startEngine, stopEngine, getPort, requestEngine } = require('../electron/engine.cjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'demo-frames');
const W = 1280, H = 800;      // 16:10 — smaller than the audit so the GIF stays light
const FPS = 10;

let win, port, frame = 0, recording = false;
ipcMain.handle('engine:request', (_event, options) => requestEngine(options));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (code) => win.webContents.executeJavaScript(code);

/** Continuous capture loop — runs while the script drives the UI. */
async function recorder() {
  const interval = 1000 / FPS;
  while (recording) {
    const started = Date.now();
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(
        path.join(OUT, `f${String(frame++).padStart(5, '0')}.png`),
        img.toPNG(),
      );
    } catch { /* window busy; skip this frame */ }
    const spent = Date.now() - started;
    if (spent < interval) await sleep(interval - spent);
  }
}

/** Hold the current screen for `ms` so viewers can read it. */
const hold = (ms) => sleep(ms);

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
    if (hit) return true;
    await sleep(150);
  }
  console.log(`  ! missed "${label}"`);
  return false;
}

async function api(method, p, body) {
  const r = await requestEngine({ path: p, method,
    body: body ? JSON.stringify(body) : undefined });
  return r.data;
}

/**
 * Show a caption over the app.
 *
 * A silent GIF has to explain itself. Injected into the page rather than
 * burned in afterwards so it moves with the app and needs no video editor.
 */
async function caption(text, sub = '') {
  await js(`(() => {
    let el = document.getElementById('__demo_caption');
    if (!el) {
      el = document.createElement('div');
      el.id = '__demo_caption';
      el.style.cssText = [
        'position:fixed','left:50%','bottom:38px','transform:translateX(-50%)',
        'z-index:99999','pointer-events:none','text-align:center',
        'padding:14px 26px','border-radius:14px',
        'background:rgba(10,14,26,0.90)','backdrop-filter:blur(10px)',
        'border:1px solid rgba(255,255,255,0.10)',
        'box-shadow:0 18px 50px rgba(0,0,0,0.55)',
        'font-family:Inter,system-ui,sans-serif','color:#F8FAFC',
        'opacity:0','transition:opacity .28s ease',
      ].join(';');
      document.body.appendChild(el);
    }
    el.innerHTML =
      '<div style="font-size:19px;font-weight:600;letter-spacing:-0.01em">' +
        ${JSON.stringify(text)} + '</div>' +
      (${JSON.stringify(sub)} ? '<div style="font-size:13.5px;color:#94A3B8;margin-top:4px">' +
        ${JSON.stringify(sub)} + '</div>' : '');
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    return true; })()`);
}

async function clearCaption() {
  await js(`(() => { const el = document.getElementById('__demo_caption');
    if (el) el.style.opacity = '0'; return true; })()`);
  await sleep(320);
}

/** Move a React Flow node so the canvas visibly reacts. */
async function dragNode(index, dx, dy, steps = 14) {
  await js(`(() => {
    const n = document.querySelectorAll('.react-flow__node')[${index}];
    if (!n) return false;
    const r = n.getBoundingClientRect();
    window.__dragFrom = { x: r.left + r.width/2, y: r.top + 18 };
    n.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles:true, cancelable:true, clientX: window.__dragFrom.x,
      clientY: window.__dragFrom.y, button:0, pointerId:1, isPrimary:true }));
    return true; })()`);

  for (let i = 1; i <= steps; i++) {
    await js(`(() => {
      const f = window.__dragFrom; if (!f) return;
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles:true, cancelable:true,
        clientX: f.x + ${dx} * ${i / steps},
        clientY: f.y + ${dy} * ${i / steps},
        button:0, pointerId:1, isPrimary:true }));
      return true; })()`);
    await sleep(45);
  }

  await js(`(() => {
    const f = window.__dragFrom; if (!f) return;
    document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles:true, cancelable:true, clientX: f.x + ${dx}, clientY: f.y + ${dy},
      button:0, pointerId:1, isPrimary:true }));
    delete window.__dragFrom; return true; })()`);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const started = await startEngine({
    isDev: true, rootDir: ROOT, resourcesPath: process.resourcesPath,
    onLog: () => {},
  });
  port = started.port ?? getPort();
  for (let i = 0; i < 80; i++) {
    try { if ((await requestEngine({ path: '/health' })).status === 200) break; } catch {}
    await sleep(250);
  }

  win = new BrowserWindow({
    width: W, height: H, show: true, frame: false,
    backgroundColor: '#0F172A', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: [`--skaffo-port=${port}`],
    },
  });

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await sleep(3000);

  // Skip the welcome — the demo is about the product, not onboarding.
  if (await js(`document.body.innerText.includes('Welcome to Skaffo')`)) {
    await click('Skip');
    await sleep(1200);
  }

  recording = true;
  recorder();
  console.log('recording…');

  // ── 1. empty workspace ──
  await caption('Skaffo starts empty', 'No sample projects — only your own work');
  await hold(1700);
  await clearCaption();

  // ── create the project through the API so the demo is not typing-bound ──
  const project = await api('POST', '/api/projects', {
    name: 'Shop API',
    description: 'Storefront — users, products and orders',
    stack: { backend: 'fastapi', frontend: 'react', database: 'sqlite',
             auth: 'jwt', docker: true, seedData: true, seedRows: 12 },
  });

  const col = (name, type, o = {}) => ({
    name, type, primaryKey: !!o.pk, nullable: !!o.nullable,
    unique: !!o.unique, defaultValue: o.def ?? null,
  });

  await api('PUT', `/api/projects/${project.id}/schema`, {
    tables: [
      { id: 't1', name: 'users', color: '#6366F1', position: { x: 40, y: 60 }, columns: [
        col('id', 'integer', { pk: true }), col('email', 'string', { unique: true }),
        col('full_name', 'string'), col('is_active', 'boolean', { def: 'true' }),
        col('created_at', 'datetime', { def: 'now()' })]},
      { id: 't2', name: 'products', color: '#10B981', position: { x: 430, y: 40 }, columns: [
        col('id', 'integer', { pk: true }), col('title', 'string'),
        col('slug', 'string', { unique: true }), col('price', 'decimal'),
        col('stock', 'integer', { def: '0' })]},
      { id: 't3', name: 'orders', color: '#7C3AED', position: { x: 230, y: 380 }, columns: [
        col('id', 'integer', { pk: true }), col('user_id', 'integer'),
        col('product_id', 'integer'), col('quantity', 'integer', { def: '1' }),
        col('total', 'decimal'), col('status', 'string', { def: "'pending'" })]},
    ],
    relations: [
      { kind: 'one-to-many', fromTableId: 't1', fromColumnIndex: 0,
        toTableId: 't3', toColumnIndex: 1, onDelete: 'cascade' },
      { kind: 'one-to-many', fromTableId: 't2', fromColumnIndex: 0,
        toTableId: 't3', toColumnIndex: 2, onDelete: 'restrict' },
    ],
  }, 'PUT');

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await sleep(2600);
  await js(`(() => {
    const c=[...document.querySelectorAll('*')].find(e =>
      (e.textContent||'').trim()==='Shop API' &&
      e.closest('[class*="cursor-pointer"],button,a'));
    const t=c&&c.closest('[class*="cursor-pointer"],button,a');
    if(t) t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return !!t; })()`);
  await sleep(1400);

  // ── 2. the schema ──
  await click('Database');
  await sleep(2000);
  await caption('Design your schema', 'Tables, columns and foreign keys on a canvas');
  await hold(1600);
  await clearCaption();

  await dragNode(2, 150, -40);           // move `orders` so the edges flex
  await hold(500);
  await dragNode(2, -150, 40);
  await hold(400);

  await js(`(() => { const n=document.querySelector('.react-flow__node');
    if(n) n.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return true; })()`);
  await caption('Every column is editable', 'Type, nullable, unique, default');
  await hold(1700);
  await clearCaption();

  // ── 3. CRUD ──
  await click('API');
  await sleep(1600);
  await caption('Generate a REST API', 'CRUD for every entity, in one click');
  await hold(1300);

  for (const e of ['users', 'products', 'orders']) {
    await api('POST', `/api/projects/${project.id}/api/generate/${e}`, {});
    await sleep(300);
  }
  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await sleep(2400);
  await js(`(() => {
    const c=[...document.querySelectorAll('*')].find(e =>
      (e.textContent||'').trim()==='Shop API' &&
      e.closest('[class*="cursor-pointer"],button,a'));
    const t=c&&c.closest('[class*="cursor-pointer"],button,a');
    if(t) t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return !!t; })()`);
  await sleep(1300);
  await click('API');
  await sleep(1700);
  await caption('18 endpoints, generated', 'Search, pagination, sorting and filtering');
  await hold(1800);
  await clearCaption();

  // ── 4. OpenAPI ──
  for (const l of ['OpenAPI', 'Spec']) if (await click(l)) break;
  await sleep(1500);
  await caption('A real OpenAPI 3.1 spec', 'Validated against the official validator');
  await hold(1900);
  await clearCaption();
  await js(`(() => { const d=document.querySelector('[class*="fixed"]');
    const b=d && [...d.querySelectorAll('button')].find(x=>!(x.textContent||'').trim());
    if(b) b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return true; })()`);
  await sleep(900);

  // ── 5. export ──
  await click('Export');
  await sleep(2000);
  await caption('Then it writes the code', 'Not a mockup — real files on disk');
  await hold(1600);
  await clearCaption();

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'skaffo-demo-'));
  await api('POST', `/api/projects/${project.id}/generate`,
    { path: target, dryRun: false });
  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await sleep(2400);
  await js(`(() => {
    const c=[...document.querySelectorAll('*')].find(e =>
      (e.textContent||'').trim()==='Shop API' &&
      e.closest('[class*="cursor-pointer"],button,a'));
    const t=c&&c.closest('[class*="cursor-pointer"],button,a');
    if(t) t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return !!t; })()`);
  await sleep(1300);
  await click('Export');
  await sleep(2200);
  await caption('53 files generated', 'FastAPI · SQLAlchemy · Alembic · React · tests');
  await hold(2000);
  await clearCaption();

  // ── 6. the payoff: show the actual generated source ──
  const files = [
    ['backend/app/models/user.py', 'SQLAlchemy model'],
    ['backend/app/routers/products.py', 'FastAPI router'],
    ['backend/app/seed.py', 'Believable sample data'],
  ];
  for (const [rel, label] of files) {
    const full = path.join(target, rel);
    if (!fs.existsSync(full)) continue;
    const body = fs.readFileSync(full, 'utf8').split('\n').slice(0, 30).join('\n');
    await js(`(() => {
      let el = document.getElementById('__demo_code');
      if (!el) {
        el = document.createElement('div');
        el.id = '__demo_code';
        el.style.cssText = [
          'position:fixed','inset:0','z-index:99998',
          'background:rgba(6,10,20,0.94)','backdrop-filter:blur(6px)',
          'display:flex','flex-direction:column','align-items:center',
          'justify-content:center','padding:56px',
          'font-family:Inter,system-ui,sans-serif','opacity:0',
          'transition:opacity .3s ease',
        ].join(';');
        document.body.appendChild(el);
      }
      el.innerHTML =
        '<div style="width:100%;max-width:900px">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
            '<span style="font-size:12px;color:#818CF8;background:rgba(99,102,241,.15);' +
              'padding:4px 10px;border-radius:999px">' + ${JSON.stringify(label)} + '</span>' +
            '<span style="font-family:ui-monospace,monospace;font-size:13px;color:#94A3B8">' +
              ${JSON.stringify(rel)} + '</span>' +
          '</div>' +
          '<pre style="margin:0;padding:22px;border-radius:14px;background:#0B1120;' +
            'border:1px solid rgba(255,255,255,.08);overflow:hidden;' +
            'font-family:ui-monospace,SFMono-Regular,monospace;font-size:12.5px;' +
            'line-height:1.65;color:#CBD5E1;white-space:pre;text-align:left">' +
            ${JSON.stringify(body)}.replace(/&/g,'&amp;').replace(/</g,'&lt;') +
          '</pre>' +
        '</div>';
      requestAnimationFrame(() => { el.style.opacity = '1'; });
      return true; })()`);
    await hold(2100);
  }

  await js(`(() => { const el=document.getElementById('__demo_code');
    if (el) el.style.opacity='0'; return true; })()`);
  await sleep(400);
  await js(`(() => { const el=document.getElementById('__demo_code');
    if (el) el.remove(); return true; })()`);

  // ── closing ──
  await click('Dashboard');
  await sleep(1500);
  await caption('Free and open source', 'No account · no telemetry · nothing leaves your machine');
  await hold(2400);
  await clearCaption();
  await hold(600);

  recording = false;
  await sleep(400);
  console.log(`captured ${frame} frames -> ${OUT}`);
  fs.rmSync(target, { recursive: true, force: true });
  stopEngine();
  app.exit(0);
}

app.whenReady().then(main).catch((e) => {
  console.error('FATAL', e);
  stopEngine();
  app.exit(1);
});
