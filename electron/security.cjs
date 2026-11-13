const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

function isSafeExternal(raw) {
  try {
    const url = new URL(raw);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username && !url.password && Boolean(url.hostname);
  } catch { return false; }
}

function isTrustedFrame(frame, mainFrame, isDev, root) {
  if (!frame || frame !== mainFrame) return false;
  if (isDev) {
    try { return new URL(frame.url).origin === 'http://localhost:5273'; }
    catch { return false; }
  }
  return frame.url === pathToFileURL(path.join(root, 'dist', 'index.html')).href;
}

function isKnownProjectDir(dir, projects) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || !Array.isArray(projects)) return false;
  try {
    const real = fs.realpathSync(dir);
    const key = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
    if (!fs.statSync(real).isDirectory() || key(path.resolve(dir)) !== key(real)) return false;
    return projects.some((project) => typeof project.path === 'string' &&
      path.isAbsolute(project.path) && key(path.resolve(project.path)) === key(real));
  } catch { return false; }
}

module.exports = { isSafeExternal, isTrustedFrame, isKnownProjectDir };
