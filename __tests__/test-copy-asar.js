const fs = require('fs');  // Use the built-in fs module for this test
const path = require('path');

const srcDir = 'D:\\test-source';  // Update with your actual source directory
const destDir = 'D:\\test-destination';  // Update with your actual destination directory

async function copyAsarFile(srcFile, destFile) {
    try {
        console.log(`Preparing to copy .asar file: ${srcFile} to ${destFile}`);

        // Copy the .asar file
        fs.copyFile(srcFile, destFile, (err) => {
            if (err) {
                console.error(`Error copying file: ${err.message}`);
            } else {
                console.log(`Successfully copied .asar file: ${srcFile} to ${destFile}`);
            }
        });
    } catch (error) {
        console.error(`Error during copy operation: ${error.message}`);
    }
}

// Define source and destination paths for the .asar file
const srcFilePath = path.join(srcDir, 'test-file.asar');
const destFilePath = path.join(destDir, 'test-file.asar');

// Execute the copy operation
copyAsarFile(srcFilePath, destFilePath);
