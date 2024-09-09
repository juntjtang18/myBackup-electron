const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');  // Using fs-extra for file system operations

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

    const files = await fs.readdir(srcDir);  // Read source directory

    for (const file of files) {
        const srcPath = path.join(srcDir, file);
        const destPath = path.join(destDir, file);

        const stats = await fs.stat(srcPath);  // Get file stats

        if (stats.isDirectory()) {
            // Ensure the destination directory exists
            await fs.ensureDir(destPath);
            // Recursively sync subdirectories
            await syncFolders(srcPath, destPath);
        } else {
            // Copy files if they are newer or don't exist in the destination
            if (!await fs.pathExists(destPath) || (await fs.stat(srcPath)).mtime > (await fs.stat(destPath)).mtime) {
                console.log(`Copying ${srcPath} to ${destPath}`);
                await fs.copyFile(srcPath, destPath);
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
