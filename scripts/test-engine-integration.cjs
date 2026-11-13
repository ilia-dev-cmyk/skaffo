// Exercise the real Python sidecar through the same authenticated proxy used
// by Electron, and verify that direct loopback requests cannot read/write.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startEngine, stopEngine } = require('../electron/engine.cjs');

(async () => {
  const root = path.join(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skaffo-api-test-'));
  process.env.SKAFFO_DATA_DIR = dataDir;
  try {
    const { port } = await startEngine({ isDev: true, rootDir: root,
      onLog: (line) => { if (line.includes('Traceback')) console.error(line); } });
    let ready = false;
    for (let n = 0; n < 60; n++) {
      try {
        const response = await request('/health');
        if (response.status === 200) { ready = true; break; }
      } catch { /* startup in progress */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert(ready, 'authenticated engine failed to become ready');
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${url}/health`)).status, 401);
    assert.equal((await fetch(`${url}/api/projects`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${url}/health`, { headers: {
      Host: 'evil.example', Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request('/api/projects')).status, 200);
    const created = await request('/api/projects', 'POST', JSON.stringify({
      name: 'Integration Test', description: '',
      stack: { backend: 'fastapi', frontend: 'react', database: 'sqlite', auth: 'none' },
    }));
    assert.equal(created.status, 201, JSON.stringify(created));
    console.log('5 integration checks passed (authenticated read/write, unauthenticated read/write, hostile Host)');
  } finally {
    stopEngine();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

function request(route, method = 'GET', body) {
  return require('../electron/engine.cjs').requestEngine({ path: route, method, body });
}
