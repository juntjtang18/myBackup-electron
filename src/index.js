const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');  // Using the native fs module
const util = require('util');

// Promisify necessary fs methods for async/await usage
const readdir = util.promisify(fs.readdir);
const stat = util.promisify(fs.stat);
const copyFile = util.promisify(fs.copyFile);
const mkdir = util.promisify(fs.mkdir);
const access = util.promisify(fs.access);

// Function to create the main application window
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

    // Handle folder selection dialog
    ipcMain.handle('open-dialog', async (event, id) => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory']
        });
        if (result.canceled) return;
        return { id, path: result.filePaths[0] };
    });

    // Handle folder synchronization
    ipcMain.handle('sync-folders', async (event, { folder1, folder2 }) => {
        try {
            if (!folder1 || !folder2) {
                throw new Error('Both folder paths must be provided.');
            }
            await syncFolders(folder1, folder2);  // Call the sync function
            return { success: true };
        } catch (error) {
            console.error('Sync error:', error);
            return { success: false, error: error.message };
        }
    });
}

// Function to sync folders, including subdirectories and newer files
async function syncFolders(srcDir, destDir) {
    // Validate folder paths
    if (typeof srcDir !== 'string' || typeof destDir !== 'string') {
        throw new Error('Invalid folder paths.');
    }

    const files = await readdir(srcDir);  // Read source directory

    for (const file of files) {
        const srcPath = path.join(srcDir, file);
        const destPath = path.join(destDir, file);

        const stats = await stat(srcPath);  // Get file stats

        if (stats.isDirectory()) {
            // Ensure the destination directory exists
            try {
                await access(destPath);
            } catch {
                await mkdir(destPath, { recursive: true });
            }
            // Recursively sync subdirectories
            await syncFolders(srcPath, destPath);
        } else if (path.extname(srcPath) === '.asar') {
            // Handle .asar files
            console.log(`Copying .asar file: ${srcPath} to ${destPath}`);
            try {
                await copyFile(srcPath, destPath);
            } catch (error) {
                console.error(`Error copying .asar file from ${srcPath} to ${destPath}:`, error);
            }
        } else {
            // Copy regular files if they are newer or don't exist in the destination
            try {
                await access(destPath);
                const srcStat = await stat(srcPath);
                const destStat = await stat(destPath);

                if (srcStat.mtime > destStat.mtime) {
                    console.log(`Copying file: ${srcPath} to ${destPath}`);
                    await copyFile(srcPath, destPath);
                }
            } catch {
                console.log(`Copying file: ${srcPath} to ${destPath}`);
                await copyFile(srcPath, destPath);
            }
        }
    }
}

// App lifecycle management
app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// Quit the app when all windows are closed, except on macOS
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
