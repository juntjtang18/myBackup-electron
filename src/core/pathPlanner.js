const path = require('path');
const { toPosixPath } = require('./layout');
const { sanitizeSegment } = require('./ids');

function buildConflictPath(logicalPath, machineId, sourceId) {
  const extension = path.posix.extname(logicalPath);
  const basename = path.posix.basename(logicalPath, extension);
  const directory = path.posix.dirname(logicalPath);
  const suffix = sanitizeSegment(`${machineId}-${sourceId}`);
  return path.posix.join(directory, `${basename} [${suffix}]${extension}`);
}

function normalizeTargetFolder(targetFolder) {
  const raw = typeof targetFolder === 'string' ? targetFolder.trim() : '';
  if (!raw || raw === '.' || raw === path.sep || raw === path.posix.sep) {
    return '';
  }

  const normalized = toPosixPath(raw).replace(/^\/+/, '');
  if (!normalized || normalized === '.') {
    return '';
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('targetFolder must stay inside the selected backup target.');
  }

  return segments.join('/');
}

function getSourceFolderName(source) {
  return path.basename(path.resolve(source.sourcePath || '')) || source.sourceId;
}

function getSourceTargetRoot(_machineId, source) {
  const targetFolder = normalizeTargetFolder(source.targetFolder);
  const sourceFolderName = getSourceFolderName(source);
  return targetFolder
    ? path.posix.join(targetFolder, sourceFolderName)
    : sourceFolderName;
}

function planLogicalTarget(input) {
  const sourceRelativePath = toPosixPath(input.sourceRelativePath || '');
  return path.posix.join(getSourceTargetRoot(input.machineId, input.source), sourceRelativePath);
}

module.exports = {
  buildConflictPath,
  getSourceFolderName,
  getSourceTargetRoot,
  normalizeTargetFolder,
  planLogicalTarget
};
