const fs = require('fs');
const path = require('path');

const srcFile = 'D:/develop/Testfolder1/node_modules/electron/dist/resources/default_app.asar';
const destFile = 'D:/Testfolder2/node_modules/electron/dist/resources/default_app.asar';

fs.copyFile(srcFile, destFile, (err) => {
    if (err) {
        console.error('Error copying file:', err);
    } else {
        console.log('File copied successfully!');
    }
});
