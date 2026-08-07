const { contextBridge, ipcRenderer } = require('electron');

// main.cjs passes the real port via additionalArguments
const portArg = process.argv.find((a) => a.startsWith('--skaffo-port='));
const enginePort = portArg ? Number(portArg.split('=')[1]) : 8731;

contextBridge.exposeInMainWorld('skaffo', {
  isDesktop: true,
  enginePort,
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    platform: () => ipcRenderer.invoke('app:platform'),
  },
  engine: {
    port: () => ipcRenderer.invoke('engine:port'),
  },
  // Running a generated project. The renderer picks a *mode*, never a
  // command — main.cjs maps modes to commands from a fixed list.
  run: {
    check: () => ipcRenderer.invoke('run:check'),
    inspect: (dir) => ipcRenderer.invoke('run:inspect', dir),
    launch: (options) => ipcRenderer.invoke('run:launch', options),
    openFolder: (dir) => ipcRenderer.invoke('run:open-folder', dir),
  },
  // GitHub publishing. Note what is NOT here: there is no `getToken`. The
  // renderer can save a token and start a publish, but can never read one
  // back, so a compromised UI cannot exfiltrate it.
  github: {
    status: () => ipcRenderer.invoke('gh:status'),
    saveToken: (token) => ipcRenderer.invoke('gh:save-token', token),
    useSessionToken: (token) => ipcRenderer.invoke('gh:use-session-token', token),
    forgetToken: () => ipcRenderer.invoke('gh:forget-token'),
    publish: (options) => ipcRenderer.invoke('gh:publish', options),
    onProgress: (callback) => {
      const handler = (_e, step) => callback(step);
      ipcRenderer.on('gh:progress', handler);
      return () => ipcRenderer.removeListener('gh:progress', handler);
    },
  },
});
