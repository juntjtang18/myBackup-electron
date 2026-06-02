const fs = require('fs-extra');
const path = require('path');
const { errorReportPath, toPosixPath } = require('./layout');

async function createErrorReportWriter(targetRoot, machineId, sourceId, scanId) {
  const reportPath = errorReportPath(targetRoot, machineId, sourceId, scanId);
  await fs.ensureDir(path.dirname(reportPath));

  return {
    reportPath,
    async append(entry) {
      const payload = {
        timestamp: new Date().toISOString(),
        machineId,
        sourceId,
        scanId,
        ...entry,
        relativePath: entry.relativePath ? toPosixPath(entry.relativePath) : null
      };
      await fs.appendFile(reportPath, `${JSON.stringify(payload)}\n`, 'utf8');
    }
  };
}

module.exports = {
  createErrorReportWriter
};
