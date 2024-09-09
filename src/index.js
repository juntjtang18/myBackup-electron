const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const util = require('util');
const ncp = require('ncp').ncp; // For copying directories
const stat = util.promisify(fs.stat);
const copy = util.promisify(ncp);

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            enableRemoteModule: false,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    ipcMain.handle('open-dialog', async (event, id) => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory']
        });
        if (result.canceled) return;
        return { id, path: result.filePaths[0] };
    });

    ipcMain.handle('sync-folders', async (event, folder1, folder2) => {
        try {
            await syncFolders(folder1, folder2);
            return { status: 'success', message: 'Folders synced successfully!' };
        } catch (error) {
            console.error('Sync error:', error);
            return { status: 'error', message: 'Failed to sync folders: ' + error.message };
        }
    });
}

async function syncFolders(src, dest) {
    async function copyNewerFiles(srcDir, destDir) {
        const srcFiles = await fs.promises.readdir(srcDir);
        for (const file of srcFiles) {
            const srcFile = path.join(srcDir, file);
            const destFile = path.join(destDir, file);
            try {
                const srcStat = await stat(srcFile);
                try {
                    const destStat = await stat(destFile);
                    if (srcStat.mtime > destStat.mtime) {
                        if (srcStat.isDirectory()) {
                            await copy(srcFile, destFile, { filter: () => true });
                        } else {
                            await fs.promises.copyFile(srcFile, destFile);
                        }
                    }
                } catch (err) {
                    // File does not exist in destination, copy it
                    if (srcStat.isDirectory()) {
                        await fs.promises.mkdir(destFile, { recursive: true });
                        await copy(srcFile, destFile, { filter: () => true });
                    } else {
                        await fs.promises.copyFile(srcFile, destFile);
                    }
                }
            } catch (err) {
                // File does not exist in destination, copy it
                if (srcStat.isDirectory()) {
                    await fs.promises.mkdir(destFile, { recursive: true });
                    await copy(srcFile, destFile, { filter: () => true });
                } else {
                    await fs.promises.copyFile(srcFile, destFile);
                }
            }
        }
    }

    await copyNewerFiles(src, dest);
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
