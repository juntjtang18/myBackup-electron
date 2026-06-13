const { createBoundedQueue } = require('../pipeline/boundedQueue');

function createFileQueue(options = {}) {
  return createBoundedQueue({
    ...options,
    name: options.name || 'file'
  });
}

module.exports = {
  createFileQueue
};
