const {
  createInFlightHashCoordinator,
  isTransientSourceFileError,
  processFileTask
} = require('../fileTaskProcessor');

module.exports = {
  createFileTaskHashCoordinator: createInFlightHashCoordinator,
  isTransientSourceFileError,
  processFileTask
};
