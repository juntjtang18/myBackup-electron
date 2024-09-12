const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    ipcRenderer: {
        on: (channel, func) => {
            ipcRenderer.on(channel, (event, ...args) => func(event, ...args));
        },
        invoke: (channel, data) => ipcRenderer.invoke(channel, data)
    }
});
