const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('myBackup', {
  version: 'step-1-foundation'
});
