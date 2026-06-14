const { readFolderEntries, isMissingPathError, statFile } = require('./scannerUtils');
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

  const folderIterator = resumeFrom
    ? walkFoldersFromCursor(sourcePath, resumeFrom, { ignoreMatcher })
    : null;

  if (folderIterator) {
    for await (const folder of folderIterator) {
      if (shouldAbort()) {
        break;
      }

      await onFolder(folder);

      let entries;
      try {
        entries = await readFolderEntries(folder.folderPath, folder.relativePath, ignoreMatcher);
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
        summary.skippedFolders += 1;
        await onMissingFolder(folder, error);
        continue;
      }

      summary.foldersScanned += 1;
      const folderTasks = [];

      for (const fileEntry of entries.files) {
        if (shouldAbort()) {
          break;
        }

        let stats;
        try {
          stats = await statFile(fileEntry.path);
        } catch (error) {
          summary.skippedFiles += 1;
          await onMissingFile(fileEntry, error);
          continue;
        }

        folderTasks.push(enqueueFile({
          sourceFilePath: fileEntry.path,
          sourceRelativePath: fileEntry.relativePath,
          stats
        }));
        summary.filesEnqueued += 1;
      }

      await Promise.allSettled(folderTasks);
      await onFolderCompleted(folder);
    }

    return summary;
  }

  const stack = [{ folderPath: sourcePath, relativePath: '.' }];
  while (stack.length > 0) {
    if (shouldAbort()) {
      break;
    }

    const folder = stack.pop();
    await onFolder(folder);

    let entries;
    try {
      entries = await readFolderEntries(folder.folderPath, folder.relativePath, ignoreMatcher);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      summary.skippedFolders += 1;
      await onMissingFolder(folder, error);
      continue;
    }

    summary.foldersScanned += 1;
    const folderTasks = [];

    for (let index = entries.directories.length - 1; index >= 0; index -= 1) {
      const directory = entries.directories[index];
      stack.push({
        folderPath: directory.path,
        relativePath: directory.relativePath
      });
    }

    for (const fileEntry of entries.files) {
      if (shouldAbort()) {
        break;
      }

      let stats;
      try {
        stats = await statFile(fileEntry.path);
      } catch (error) {
        summary.skippedFiles += 1;
        await onMissingFile(fileEntry, error);
        continue;
      }

      folderTasks.push(enqueueFile({
        sourceFilePath: fileEntry.path,
        sourceRelativePath: fileEntry.relativePath,
        stats
      }));
      summary.filesEnqueued += 1;
    }

    await Promise.allSettled(folderTasks);
    await onFolderCompleted(folder);
  }

  return summary;
}

module.exports = {
  scanFullSource
};
