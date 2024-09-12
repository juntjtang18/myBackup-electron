const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');

// Disable .asar support
process.noAsar = true;

// Function to create the main application window
function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            enableRemoteModule: true,
            nodeIntegration: true
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

    ipcMain.handle('sync-folders', async (event, { folder1, folder2 }) => {
        try {
            if (!folder1 || !folder2) {
                throw new Error('Both folder paths must be provided.');
            }
            await syncFolders(folder1, folder2, event);
            return { success: true };
        } catch (error) {
            console.error('Sync error:', error);
            return { success: false, error: error.message };
        }
    });
}

async function syncFolders(srcDir, destDir, event) {
    const files = await fs.readdir(srcDir);
    const totalFiles = files.length;
    let processedFiles = 0;

    for (const file of files) {
        const srcPath = path.join(srcDir, file);
        const destPath = path.join(destDir, file);

        try {
            const stats = await fs.stat(srcPath);

            if (path.extname(srcPath) === '.asar') {
                await fs.ensureDir(path.dirname(destPath));
                await fs.copyFile(srcPath, destPath);
            } else if (stats.isDirectory()) {
                await fs.ensureDir(destPath);
                await syncFolders(srcPath, destPath, event); // Recursively sync sub-folders
            } else {
                const destExists = await fs.pathExists(destPath);
                if (!destExists || stats.mtime > (await fs.stat(destPath)).mtime) {
                    await fs.copyFile(srcPath, destPath);
                }
            }

            processedFiles++;
            const progress = Math.round((processedFiles / totalFiles) * 100);
            // Log the progress before sending
            console.log(`Sending progress: ${progress}%`);

            // Send progress to renderer
            const window = BrowserWindow.getAllWindows()[0];
            if (window) {
                window.webContents.send('sync-progress', progress);
            } else {
                console.log('No active window to send progress.');
            }

        } catch (error) {
            console.error(`Error processing file ${srcPath}:`, error);
        }
    }
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
