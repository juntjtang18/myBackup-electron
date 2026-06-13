const {
  createInFlightHashCoordinator,
  processFileTask
} = require('../fileTaskProcessor');

module.exports = {
  createFileTaskHashCoordinator: createInFlightHashCoordinator,
  processFileTask
};
