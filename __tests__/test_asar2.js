const fs = require('fs');
const path = require('path');

// Function to copy a file from src to dest
function copyFile(src, dest) {
    return new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(src);
        const writeStream = fs.createWriteStream(dest);

        readStream.on('error', (err) => {
            reject(`Error reading file: ${src}, Error: ${err}`);
        });
        writeStream.on('error', (err) => {
            reject(`Error writing file: ${dest}, Error: ${err}`);
        });
        writeStream.on('close', resolve);

        readStream.pipe(writeStream);
    });
}

// Function to synchronize folders
async function syncFolders(srcDir, destDir) {
    try {
        const files = await fs.promises.readdir(srcDir, { withFileTypes: true });

        for (const file of files) {
            const srcPath = path.join(srcDir, file.name);
            const destPath = path.join(destDir, file.name);

            const stats = await fs.promises.stat(srcPath);
            console.log(`Stats for ${srcPath}:`, stats);

            // Check if the file is a .asar file
            if (file.isFile() && path.extname(file.name) === '.asar') {
                console.log(`Copying .asar file: ${srcPath} to ${destPath}`);
                await copyFile(srcPath, destPath);
                console.log(`Copied .asar file: ${srcPath} to ${destPath}`);
            }
            // If it's a directory, recursively sync
            else if (file.isDirectory()) {
                console.log(`Creating directory: ${destPath}`);
                await fs.promises.mkdir(destPath, { recursive: true });
                await syncFolders(srcPath, destPath);
            }
            // If it's a regular file, copy it
            else if (file.isFile()) {
                console.log(`Copying file: ${srcPath} to ${destPath}`);
                await copyFile(srcPath, destPath);
                console.log(`Copied file: ${srcPath} to ${destPath}`);
            }
        }
    } catch (err) {
        console.error(`Error during synchronization: ${err}`);
    }
}

// Source and destination directories
const sourceDir = 'D:/develop/Testfolder1';
const destinationDir = 'D:/Testfolder2';

// Start the folder synchronization process
syncFolders(sourceDir, destinationDir)
    .then(() => {
        console.log('Folder synchronization completed.');
    })
    .catch((error) => {
        console.error('Error during folder synchronization:', error);
    });
