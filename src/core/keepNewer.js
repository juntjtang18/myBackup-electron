const DEFAULT_MTIME_TOLERANCE_MS = 2000;

function isMtimeWithinTolerance(sourceMtimeMs, destMtimeMs, toleranceMs = DEFAULT_MTIME_TOLERANCE_MS) {
  return Math.abs(Number(sourceMtimeMs || 0) - Number(destMtimeMs || 0)) <= Number(toleranceMs || 0);
}

function shouldCopyWhenSourceNewer(sourceStat, destStat, toleranceMs = DEFAULT_MTIME_TOLERANCE_MS) {
  if (!destStat) {
    return true;
  }
  return Number(sourceStat?.mtimeMs || 0) > (Number(destStat?.mtimeMs || 0) + Number(toleranceMs || 0));
}

module.exports = {
  DEFAULT_MTIME_TOLERANCE_MS,
  isMtimeWithinTolerance,
  shouldCopyWhenSourceNewer
};
