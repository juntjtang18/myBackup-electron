const fs = require('fs-extra');
const path = require('path');
const { errorReportPath, toPosixPath } = require('./layout');
const { createLogger } = require('./logger');

const logger = createLogger('ErrorReportStore', 'errorReportStore.js');

async function createErrorReportWriter(targetRoot, machineId, sourceId, scanId) {
  const reportPath = errorReportPath(targetRoot, machineId, sourceId, scanId);
  try {
    await fs.ensureDir(path.dirname(reportPath));
  } catch (error) {
    logger.warn('Failed to create error report directory.', {
      reportPath,
      error: error && error.message ? error.message : String(error)
    });
  }

  return {
    reportPath,
    async append(entry) {
      try {
        await fs.ensureDir(path.dirname(reportPath));
        const payload = {
          timestamp: new Date().toISOString(),
          machineId,
          sourceId,
          scanId,
          ...entry,
          relativePath: entry.relativePath ? toPosixPath(entry.relativePath) : null
        };
        await fs.appendFile(reportPath, `${JSON.stringify(payload)}\n`, 'utf8');
      } catch (error) {
        logger.warn('Failed to write error report entry; continuing.', {
          reportPath,
          relativePath: entry && entry.relativePath ? entry.relativePath : null,
          error: error && error.message ? error.message : String(error)
        });
      }
    }
  };
}

module.exports = {
  createErrorReportWriter
};
