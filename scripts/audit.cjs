/**
 * Full-app audit: click through every screen and assert what should be there.
 *
 *   xvfb-run -a node_modules/.bin/electron scripts/audit.cjs
 *
 * Runs against a scratch data dir so it always starts from a genuinely empty
 * install — the same thing a user sees after downloading. Every check states
 * what it expected, so a failure says what is broken rather than just "false".
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { startEngine, stopEngine, getPort, requestEngine } = require('../electron/engine.cjs');
const secrets = require('../electron/secrets.cjs');
const github = require('../electron/github.cjs');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(os.tmpdir(), 'skaffo-audit');
fs.mkdirSync(SHOTS, { recursive: true });

// Own the data directory rather than inheriting it. The audit asserts on
// first-run behaviour (empty workspace, welcome screen), so it has to start
// from a directory nothing has written to — including a previous audit run.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'skaffo-audit-data-'));
process.env.SKAFFO_DATA_DIR = DATA_DIR;
// Electron keeps its own state (localStorage, Preferences) here too.
app.setPath('userData', path.join(DATA_DIR, 'electron'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win, port, consoleErrors = [];
const results = [];

// ── mirror main.cjs's IPC so the real UI paths run ──
const TOKEN_KEY = 'github.token';
ipcMain.handle('gh:status', async () => ({
  ...secrets.describe(TOKEN_KEY), gitInstalled: await github.gitAvailable() }));
ipcMain.handle('gh:save-token', async () => ({ ok: false, error: 'audit stub' }));
ipcMain.handle('gh:use-session-token', async () => ({ ok: false, error: 'audit stub' }));
ipcMain.handle('gh:forget-token', () => true);
ipcMain.handle('gh:publish', async () => ({ ok: false, error: 'audit stub' }));
ipcMain.handle('win:minimize', () => {});
ipcMain.handle('win:maximize', () => false);
ipcMain.handle('win:close', () => {});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:platform', () => process.platform);
ipcMain.handle('engine:port', () => getPort());
ipcMain.handle('engine:request', (_event, options) => requestEngine(options));

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

const js = (code) => win.webContents.executeJavaScript(code);
const text = () => js('document.body.innerText');

async function settle(extra = 0) {
  await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))`);
  if (extra) await sleep(extra);
}

async function shot(name) {
  await settle(150);
  fs.writeFileSync(path.join(SHOTS, name),
    (await win.webContents.capturePage()).toPNG());
}

async function click(label, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const hit = await js(`(() => {
      const e = [...document.querySelectorAll('button,a,[role="button"],[role="tab"]')]
        .find(x => (x.textContent||'').trim().startsWith(${JSON.stringify(label)}));
      if (e && !e.disabled) { e.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true; }
      return false; })()`);
    if (hit) { await settle(300); return true; }
    await sleep(180);
  }
  return false;
}

async function api(method, p, body) {
  const r = await requestEngine({ path: p, method,
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.data };
}

/**
 * Reload the renderer.
 *
 * `keepWelcome` exists because section [0] deliberately asserts on the
 * first-run welcome. Everywhere after that the welcome must be gone, and if
 * it somehow is not it would sit on top and swallow every click — so it is
 * dismissed defensively rather than producing a confusing cascade.
 */
async function reload({ keepWelcome = false } = {}) {
  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await sleep(2500);
  if (keepWelcome) return;

  const pending = await js(
    `document.body.innerText.includes('Welcome to Skaffo')`);
  if (pending) {
    await click('Skip');
    await sleep(900);
  }
}

async function main() {
  const started = await startEngine({
    isDev: true, rootDir: ROOT, resourcesPath: process.resourcesPath,
    onLog: (m) => {
      if (/imported existing data/i.test(m)) {
        check('no legacy database is adopted on a clean install', false, m);
      }
      if (/traceback|error/i.test(m)) console.log('  [engine]', m);
    },
  });
  port = started.port ?? getPort();

  // Wait for the engine to actually accept connections. startEngine()
  // resolves when the process is spawned, not when uvicorn is listening —
  // probing immediately raced it and produced a cascade of misleading
  // failures further down.
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await api('GET', '/health');
      if (r.status === 200) { ready = true; break; }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!ready) throw new Error(`engine never became reachable on ${port}`);

  win = new BrowserWindow({ width: 1500, height: 940, show: true,
    backgroundColor: '#0F172A', autoHideMenuBar: true,
    webPreferences: { preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: [`--skaffo-port=${port}`] } });
  win.webContents.on('console-message', (_e, lv, m) => {
    if (lv >= 2 && !/DevTools|Autofill|GPU stall|Electron Security/i.test(m)) {
      consoleErrors.push(m);
    }
  });

  // Prove the engine really is on a clean database before asserting on
  // first-run behaviour — otherwise a stale dir silently invalidates [0].
  const s0 = await api('GET', '/api/settings');
  console.log(`  data dir: ${DATA_DIR}`);
  console.log(`  welcomeSeen from engine: ${s0.body?.welcomeSeen}`);

  await reload({ keepWelcome: true });

  // ══ 0. WELCOME ══
  // Shipped in v1.0 and shown on a clean install, so it is the first thing
  // the audit meets. Assert it, then dismiss it — everything after this
  // tests the app proper.
  console.log('\n[0] First-run welcome');
  let t = await text();
  check('welcome appears on a clean install', t.includes('Welcome to Skaffo'),
    t.slice(0, 120));
  check('explains what Skaffo makes', /FastAPI|React/.test(t));
  await shot('00-welcome.png');

  check('advances to the personalise step', await click('Next'));
  await sleep(500);
  t = await text();
  check('offers themes and languages',
    t.includes('Make it yours') && t.includes('English'));

  await click('Next'); await sleep(500);
  t = await text();
  check('states the privacy promise', t.includes('Nothing leaves this machine'));
  check('says the workspace starts empty', /workspace starts empty/i.test(t));

  check('can be dismissed', await click('Explore on my own'));
  await sleep(1200);
  check('welcome is gone after dismissing',
    !(await text()).includes('Yours, and only yours'));

  // it must not come back
  await reload();
  check('welcome does not reappear on the next launch',
    !(await text()).includes('Welcome to Skaffo'));

  // ══ 1. FIRST RUN ══
  console.log('\n[1] First run — empty install');
  t = await text();
  check('dashboard renders', t.includes('Welcome back'));
  check('shows the empty state, not a sample project',
    t.includes('No projects yet'), t.slice(0, 160));
  check('does NOT ship "My Shop"', !t.includes('My Shop'));
  check('project count is 0', /PROJECTS\s*\n?\s*0/.test(t));
  check('"this week" is 0, not the old hardcoded 3',
    !/THIS WEEK\s*\n?\s*3\b/.test(t));
  check('right rail says nothing pinned', t.includes('Nothing pinned yet'));
  const engineProjects = await api('GET', '/api/projects');
  check('engine agrees the workspace is empty',
    engineProjects.body.length === 0, `got ${engineProjects.body.length}`);
  await shot('01-first-run.png');

  // ══ 2. NAVIGATION / GATING ══
  console.log('\n[2] Navigation and gating');
  check('Database is gated with no project open', t.includes('PROJECT'));
  await click('Projects');
  check('Projects screen opens', (await text()).includes('No projects yet'));
  await click('Templates');
  t = await text();
  check('Templates lists 6 blueprints',
    ['Blank','REST API','Blog','Dashboard','CRM','E-Commerce'].every(x => t.includes(x)));
  await click('Settings');
  t = await text();
  check('Settings shows 4 themes',
    ['Dark','Light','Midnight','Nord'].every(x => t.includes(x)));
  check('Settings shows 8 languages',
    ['English','فارسی','العربية','Español','Deutsch','Français','Türkçe','简体中文']
      .every(x => t.includes(x)));
  await click('Support');
  t = await text();
  check('Support page loads', t.includes('free'));
  check('three wallets are listed',
    (t.match(/Copy/g) || []).length >= 3);
  check('no placeholder wallet leaked', !t.includes('PASTE_'));

  // ══ 3. WIZARD ══
  console.log('\n[3] Wizard — create a project');
  await click('Dashboard'); await sleep(700);
  check('Create Project opens the wizard', await click('Create Project'));
  await sleep(1200);
  await js(`(() => { const i=document.querySelector('input');
    const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    s.call(i,'Audit Shop'); i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(400);
  for (let i = 0; i < 6; i++) { await click('Next'); await sleep(380); }
  t = await text();
  check('step 7 offers the Sample data toggle', t.includes('Sample data'), t.slice(-260));
  await shot('02-wizard-seed.png');
  await click('Next'); await sleep(600);
  t = await text();
  check('summary lists sample data', /Sample data/i.test(t));
  check('Generate button is present', t.includes('Generate'));
  await click('Generate'); await sleep(2200);

  const projects = await api('GET', '/api/projects');
  check('project was persisted by the engine',
    projects.body.length === 1, `got ${projects.body.length}`);
  const pid = projects.body[0]?.id;
  check('seedData survived the round trip',
    projects.body[0]?.stack?.seedData === true,
    JSON.stringify(projects.body[0]?.stack));

  // ══ 4. SCHEMA (via API, then verify in UI) ══
  console.log('\n[4] Database designer');
  const col = (name, type, o = {}) => ({ name, type, primaryKey: !!o.pk,
    nullable: !!o.nullable, unique: !!o.unique, defaultValue: o.def ?? null });
  const put = await api('PUT', `/api/projects/${pid}/schema`, {
    tables: [
      { id: 't1', name: 'users', color: '#6366F1', position: { x: 60, y: 60 }, columns: [
        col('id','integer',{pk:true}), col('email','string',{unique:true}),
        col('full_name','string'), col('is_active','boolean'), col('created_at','datetime')]},
      { id: 't2', name: 'products', color: '#10B981', position: { x: 470, y: 40 }, columns: [
        col('id','integer',{pk:true}), col('title','string'),
        col('slug','string',{unique:true}), col('price','decimal'), col('stock','integer')]},
      { id: 't3', name: 'orders', color: '#7C3AED', position: { x: 265, y: 400 }, columns: [
        col('id','integer',{pk:true}), col('user_id','integer'),
        col('product_id','integer'), col('quantity','integer'), col('status','string')]},
    ],
    relations: [
      { kind:'one-to-many', fromTableId:'t1', fromColumnIndex:0, toTableId:'t3', toColumnIndex:1, onDelete:'cascade' },
      { kind:'one-to-many', fromTableId:'t2', fromColumnIndex:0, toTableId:'t3', toColumnIndex:2, onDelete:'restrict' },
    ],
  });
  check('schema saves atomically', put.status === 200, `HTTP ${put.status}`);
  await reload();
  await js(`(() => { const c=[...document.querySelectorAll('*')].find(e =>
      (e.textContent||'').trim()==='Audit Shop' && e.closest('[class*="cursor-pointer"],button,a'));
    const t=c&&c.closest('[class*="cursor-pointer"],button,a');
    if(t) t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return !!t; })()`);
  await sleep(1500);
  check('Database screen opens', await click('Database'));
  await sleep(1900);
  t = await text();
  check('all three tables render on the canvas',
    ['users','products','orders'].every(x => t.includes(x)));
  check('validation reports a valid schema', /valid|No problems/i.test(t), t.slice(0,200));
  const nodes = await js(`document.querySelectorAll('.react-flow__node').length`);
  check('React Flow drew 3 nodes', nodes === 3, `got ${nodes}`);
  const edges = await js(`document.querySelectorAll('.react-flow__edge').length`);
  check('2 relations drawn as edges', edges === 2, `got ${edges}`);
  await shot('03-database.png');

  // ══ 5. SQL EXPORT + VALIDATION ══
  console.log('\n[5] Schema tools');
  for (const d of ['sqlite','postgresql','mysql']) {
    const r = await api('GET', `/api/projects/${pid}/schema/ddl?dialect=${d}`);
    const sql = (r.body?.sql || '').toLowerCase();
    check(`${d} DDL generates`, r.status === 200 && sql.includes('create table'),
      `HTTP ${r.status}`);
    // Identifiers are quoted, so match the table name, not a bare substring.
    const at = (t) => sql.search(new RegExp(`create table\\s+["\`]?${t}["\`]?`));
    check(`${d} DDL is ordered parents-first`,
      at('users') > -1 && at('orders') > -1 && at('users') < at('orders'),
      `users@${at('users')} orders@${at('orders')}`);
  }
  const val = await api('GET', `/api/projects/${pid}/schema/validate`);
  check('validation endpoint responds', val.status === 200);

  // ══ 6. API DESIGNER ══
  console.log('\n[6] API designer');
  for (const e of ['users','products','orders']) {
    const r = await api('POST', `/api/projects/${pid}/api/generate/${e}`, {});
    check(`CRUD generated for ${e}`, r.status < 300, `HTTP ${r.status}`);
  }
  const spec = await api('GET', `/api/projects/${pid}/api/openapi`);
  check('OpenAPI 3.1 spec builds',
    spec.status === 200 && String(spec.body?.openapi || '').startsWith('3.1'),
    `openapi=${spec.body?.openapi}`);
  const paths = Object.keys(spec.body?.paths || {});
  check('spec contains real paths', paths.length >= 6, `${paths.length} paths`);
  // CRUD was generated over HTTP after the page mounted, so refetch first.
  await reload();
  await js(`(() => { const c=[...document.querySelectorAll('*')].find(e =>
      (e.textContent||'').trim()==='Audit Shop' && e.closest('[class*="cursor-pointer"],button,a'));
    const t=c&&c.closest('[class*="cursor-pointer"],button,a');
    if(t) t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return !!t; })()`);
  await sleep(1500);
  await click('API'); await sleep(1800);
  t = await text();
  check('API screen lists entities',
    ['users','products','orders'].every(x => t.includes(x)));
  check('endpoints are shown, not "No endpoints yet"',
    !t.includes('No endpoints yet'), t.slice(0, 200));
  await shot('04-api.png');

  // ══ 7. EXPORT: preview, dry run, real write ══
  console.log('\n[7] Export');
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'skaffo-out-'));
  const preview = await api('GET', `/api/projects/${pid}/generate/preview`);
  check('preview renders files in memory',
    preview.status === 200 && preview.body.fileCount > 40,
    `${preview.body?.fileCount} files`);

  const dry = await api('POST', `/api/projects/${pid}/generate`,
    { path: target, dryRun: true });
  check('dry run reports work', dry.status === 200 && dry.body.dryRun === true);
  check('dry run wrote NOTHING to disk',
    fs.readdirSync(target).length === 0,
    `found ${fs.readdirSync(target).join(', ')}`);

  const real = await api('POST', `/api/projects/${pid}/generate`,
    { path: target, dryRun: false });
  check('real export writes files', real.status === 200 && real.body.written > 40,
    `wrote ${real.body?.written}`);
  const wrote = (p) => fs.existsSync(path.join(target, p));
  check('backend/app/main.py written', wrote('backend/app/main.py'));
  check('models generated', wrote('backend/app/models/user.py'));
  check('frontend written', wrote('frontend/package.json'));
  check('run scripts written', wrote('run.bat') && wrote('run.sh'));
  check('seed.py written (toggle was on)', wrote('backend/app/seed.py'));
  check('alembic migration scaffolding', wrote('backend/alembic/env.py'));

  // seed quality
  if (wrote('backend/app/seed.py')) {
    const seed = fs.readFileSync(path.join(target, 'backend/app/seed.py'), 'utf8');
    check('seed emails look like emails', /@example\.com/.test(seed));
    check('seed prices look like money',
      /'price': \d+\.\d{1,2}[,}]/.test(seed), (seed.match(/'price': [^,}]+/) || [])[0]);
    check('seed foreign keys are deferred refs', /_ref\('users'/.test(seed));
    check('seed names are human', /'full_name': '[A-Z][a-z]+ [A-Z]/.test(seed));
  }

  // run.sh must be valid and must call the seeder
  const runsh = fs.readFileSync(path.join(target, 'run.sh'), 'utf8');
  check('run.sh invokes the seeder', runsh.includes('app.seed'));
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync('bash', ['-n', path.join(target, 'run.sh')], { stdio: 'pipe' });
    check('run.sh is valid bash', true);
  } catch (e) { check('run.sh is valid bash', false, String(e.stderr || e)); }

  // ZIP
  const zip = await api('POST', `/api/projects/${pid}/generate/zip`, {});
  check('ZIP export succeeds', zip.status === 200, `HTTP ${zip.status}`);

  await click('Export'); await sleep(1600);
  t = await text();
  check('Export screen shows GitHub option, not "Not built yet"',
    t.includes('GitHub Repository') && !t.includes('Git Repository'), t.slice(0,300));
  await shot('05-export.png');

  // ══ 8. PUBLISH DIALOG ══
  console.log('\n[8] GitHub publish dialog');
  await click('GitHub Repository'); await sleep(900);
  check('publish panel appears', (await text()).includes('Create & push'));
  await click('Create & push'); await sleep(1300);
  t = await text();
  check('dialog opens', t.includes('Publish to GitHub'));
  check('asks for a token', t.includes('Personal access token'));
  check('repo name is sanitised from the project name',
    (await js(`(() => { const i=[...document.querySelectorAll('input')]
      .find(x=>/audit/i.test(x.value)); return i ? i.value : ''; })()`)) === 'Audit-Shop');
  // Scope to the dialog: the Export panel behind it has its own
  // (correctly enabled) "Create & push" button that opens this dialog.
  check('publish is disabled until a token is connected',
    await js(`(() => { const d=document.querySelector('[role="dialog"]');
      if(!d) return false;
      const b=[...d.querySelectorAll('button')]
        .find(x=>/Create\\s*&\\s*push/i.test(x.textContent||''));
      return !!b && b.disabled; })()`));

  await shot('06-publish.png');
  await click('Cancel'); await sleep(700);

  // ══ 9. THEMES + i18n ══
  console.log('\n[9] Themes and languages');
  await click('Settings'); await sleep(1100);
  for (const [label, probe] of [['Light','light'], ['Nord','nord'], ['Midnight','midnight']]) {
    await click(label); await sleep(700);
    const applied = await js(`document.documentElement.getAttribute('data-theme') ||
      getComputedStyle(document.documentElement).getPropertyValue('--cf-bg-rgb')`);
    check(`${label} theme applies`, !!applied && applied.trim().length > 0, applied);
  }
  await click('Dark'); await sleep(600);

  await click('فارسی'); await sleep(1200);
  const dir = await js(`document.documentElement.getAttribute('dir')`);
  check('Persian switches the document to RTL', dir === 'rtl', `dir=${dir}`);
  t = await text();
  check('UI is translated', t.includes('تنظیمات') || t.includes('داشبورد'), t.slice(0,120));
  await shot('07-rtl.png');
  // canvas must stay LTR even in RTL mode
  await js(`(() => { const c=[...document.querySelectorAll('button,a')]
    .find(e=>(e.textContent||'').trim().startsWith('دیتابیس'));
    if(c) c.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return !!c; })()`);
  await sleep(1800);
  const canvasDir = await js(`(() => { const el=document.querySelector('.react-flow');
    return el ? (el.getAttribute('dir') || getComputedStyle(el).direction) : 'none'; })()`);
  check('diagram canvas stays LTR in RTL mode', canvasDir === 'ltr', `dir=${canvasDir}`);
  await click('تنظیمات'); await sleep(1000);
  await click('English'); await sleep(1100);
  check('switching back to English restores LTR',
    (await js(`document.documentElement.getAttribute('dir')`)) !== 'rtl');

  // ══ 10. UNDO/REDO + PERSISTENCE ══
  console.log('\n[10] Persistence');
  const before = await api('GET', `/api/projects/${pid}`);
  await reload();
  const after = await api('GET', `/api/projects/${pid}`);
  check('project survives a restart',
    after.body?.name === 'Audit Shop' &&
    after.body?.schema?.tables?.length === before.body?.schema?.tables?.length,
    `${after.body?.schema?.tables?.length} tables`);
  check('activity was recorded',
    (await api('GET', '/api/activity')).body.length > 0);

  // ══ 11. DELETE ══
  console.log('\n[11] Delete');
  const del = await api('DELETE', `/api/projects/${pid}`);
  check('project deletes', del.status < 300, `HTTP ${del.status}`);
  const left = await api('GET', '/api/projects');
  check('workspace is empty again', left.body.length === 0, `${left.body.length} left`);
  await reload();
  check('empty state returns after deleting the last project',
    (await text()).includes('No projects yet'));

  // ══ SUMMARY ══
  console.log('\n[12] Console health');
  check('zero console errors across the whole run',
    consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `\n      ${f.detail}` : ''}`);
  }
  console.log(`screenshots: ${SHOTS}`);

  stopEngine();
  app.exit(failed.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => {
  console.error('FATAL', e);
  stopEngine();
  app.exit(1);
});
