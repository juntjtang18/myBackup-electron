const { createFixedWorkerPool } = require('../pipeline/fixedWorkerPool');

function createFileWorkerPool(options = {}) {
  if (!options.queue || typeof options.process !== 'function') {
    throw new Error('queue and process are required.');
  }

  return createFixedWorkerPool({
    queue: options.queue,
    size: options.size || 1,
    prefix: options.prefix || 'W',
    process: options.process,
    onEvent: options.onEvent
  });
}

module.exports = {
  createFileWorkerPool
};
