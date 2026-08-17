const { readFolderEntries, safeCallback, scanFolderFiles } = require('./scannerUtils');
const { walkFoldersFromCursor } = require('../cursor');

async function scanFullSource(options) {
  const sourcePath = options.sourcePath;
  const resumeFrom = options.resumeFrom || null;
  const ignoreMatcher = options.ignoreMatcher || null;
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : () => false;
  const enqueueFile = typeof options.enqueueFile === 'function' ? options.enqueueFile : async () => {};
  const onFolder = typeof options.onFolder === 'function' ? options.onFolder : async () => {};
  const onFolderCompleted = typeof options.onFolderCompleted === 'function' ? options.onFolderCompleted : async () => {};
  const onMissingFolder = typeof options.onMissingFolder === 'function' ? options.onMissingFolder : async () => {};
  const onMissingFile = typeof options.onMissingFile === 'function' ? options.onMissingFile : async () => {};

  const summary = {
    mode: 'full',
    foldersScanned: 0,
    filesEnqueued: 0,
    skippedFolders: 0,
    skippedFiles: 0
  };

  async function scanOneFolder(folder, onDirectories) {
    await safeCallback('onFolder', onFolder, folder);

    let entries;
    try {
      entries = await readFolderEntries(folder.folderPath, folder.relativePath, ignoreMatcher);
    } catch (error) {
      summary.skippedFolders += 1;
      await safeCallback('onMissingFolder', onMissingFolder, folder, error);
      return;
    }

    summary.foldersScanned += 1;
    if (typeof onDirectories === 'function') {
      onDirectories(entries.directories);
    }

    const fileSummary = await scanFolderFiles({
      files: entries.files,
      shouldAbort,
      enqueueFile,
      onFileError: onMissingFile
    });
    summary.filesEnqueued += fileSummary.filesEnqueued;
    summary.skippedFiles += fileSummary.skippedFiles;
    await safeCallback('onFolderCompleted', onFolderCompleted, folder);
  }

  const folderIterator = resumeFrom
    ? walkFoldersFromCursor(sourcePath, resumeFrom, { ignoreMatcher })
    : null;

  if (folderIterator) {
    for await (const folder of folderIterator) {
      if (shouldAbort()) {
        break;
      }
      await scanOneFolder(folder);
    }
    return summary;
  }

  const stack = [{ folderPath: sourcePath, relativePath: '.' }];
  while (stack.length > 0) {
    if (shouldAbort()) {
      break;
    }

    const folder = stack.pop();
    await scanOneFolder(folder, (directories) => {
      for (let index = directories.length - 1; index >= 0; index -= 1) {
        const directory = directories[index];
        stack.push({
          folderPath: directory.path,
          relativePath: directory.relativePath
        });
      }
    });
  }

  return summary;
}

module.exports = {
  scanFullSource
};
