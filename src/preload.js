const { clipboard, contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myBackup', {
  getRuntimeFlags: () => ipcRenderer.invoke('app:get-runtime-flags'),
  copyText: (text) => clipboard.writeText(String(text || '')),
  getDashboard: () => ipcRenderer.invoke('app:get-dashboard'),
  addTarget: () => ipcRenderer.invoke('app:add-target'),
  removeTarget: (input) => ipcRenderer.invoke('app:remove-target', input),
  setTargetCollapsed: (input) => ipcRenderer.invoke('app:set-target-collapsed', input),
  pickSourceFolder: () => ipcRenderer.invoke('app:pick-source-folder'),
  addSource: (input) => ipcRenderer.invoke('app:add-source', input),
  runBackup: (input) => ipcRenderer.invoke('app:run-backup', input),
  pauseBackup: (input) => ipcRenderer.invoke('app:pause-backup', input),
  setLogLevel: (input) => ipcRenderer.invoke('app:set-log-level', input),
  restoreSource: (input) => ipcRenderer.invoke('app:restore-source', input),
  restoreMerged: (input) => ipcRenderer.invoke('app:restore-merged', input),
  onBackupProgress: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('app:backup-progress', handler);
    return () => ipcRenderer.removeListener('app:backup-progress', handler);
  },
  onLog: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('app:log', handler);
    return () => ipcRenderer.removeListener('app:log', handler);
  },
  onDashboardUpdated: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('app:dashboard-updated', handler);
    return () => ipcRenderer.removeListener('app:dashboard-updated', handler);
  }
});
