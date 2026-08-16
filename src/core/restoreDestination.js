const path = require('path');

function getRestoreSourceFolderName(source) {
  return path.basename(path.resolve(source?.sourcePath || '')) || source?.sourceId || 'source';
}

function canReusePausedRestore(pausedJob, input = {}) {
  if (!pausedJob || pausedJob.status !== 'paused' || input.forceNewRestore) {
    return false;
  }
  return Boolean(pausedJob.requestedDestinationRoot || pausedJob.destinationRoot);
}

async function chooseRestoreDestination({
  source,
  input = {},
  pausedJob = null,
  pickDirectory,
  askAppend
} = {}) {
  if (input.destinationRoot) {
    return {
      destinationRoot: path.resolve(input.destinationRoot),
      appendFolder: Boolean(input.appendFolder)
    };
  }

  if (canReusePausedRestore(pausedJob, input)) {
    return {
      destinationRoot: pausedJob.requestedDestinationRoot || pausedJob.destinationRoot,
      appendFolder: pausedJob.requestedDestinationRoot
        ? Boolean(pausedJob.appendFolder)
        : false
    };
  }

  if (typeof pickDirectory !== 'function') {
    throw new Error('Restore destination folder is required.');
  }

  const picked = await pickDirectory({
    title: 'Select Restore Destination',
    defaultPath: source?.sourcePath || undefined
  });
  if (!picked) {
    return null;
  }

  const defaultAppend = Boolean(source?.includeSourceRoot);
  let appendFolder = defaultAppend;
  if (typeof askAppend === 'function') {
    const answered = await askAppend({
      destinationRoot: picked,
      sourceFolderName: getRestoreSourceFolderName(source),
      defaultAppend
    });
    if (answered === null || answered === undefined) {
      return null;
    }
    appendFolder = Boolean(answered);
  }

  return {
    destinationRoot: path.resolve(picked),
    appendFolder
  };
}

module.exports = {
  canReusePausedRestore,
  chooseRestoreDestination,
  getRestoreSourceFolderName
};
