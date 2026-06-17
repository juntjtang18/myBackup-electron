function createStatusCheckpointWriter(options = {}) {
  if (typeof options.buildSnapshot !== 'function') {
    throw new Error('buildSnapshot is required.');
  }
  if (typeof options.persistSnapshot !== 'function') {
    throw new Error('persistSnapshot is required.');
  }

  const buildSnapshot = options.buildSnapshot;
  const persistSnapshot = options.persistSnapshot;
  const nowFactory = typeof options.nowFactory === 'function' ? options.nowFactory : () => new Date();

  let dirty = false;
  let flushing = false;
  let scheduled = false;
  let closed = false;
  const waiters = [];

  function resolveWaiters() {
    if (flushing || dirty) {
      return;
    }
    while (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve();
    }
  }

  async function flushLoop() {
    if (flushing || closed) {
      return;
    }
    flushing = true;
    scheduled = false;
    try {
      while (dirty && !closed) {
        dirty = false;
        const snapshot = buildSnapshot();
        await persistSnapshot(snapshot, nowFactory());
      }
    } finally {
      flushing = false;
      resolveWaiters();
      if (dirty && !scheduled && !closed) {
        scheduled = true;
        queueMicrotask(() => {
          void flushLoop();
        });
      }
    }
  }

  function markDirty() {
    if (closed) {
      return;
    }
    dirty = true;
    if (!scheduled && !flushing) {
      scheduled = true;
      queueMicrotask(() => {
        void flushLoop();
      });
    }
  }

  async function flushPending() {
    if (closed) {
      return;
    }
    if (dirty && !scheduled && !flushing) {
      scheduled = true;
      queueMicrotask(() => {
        void flushLoop();
      });
    }
    if (!dirty && !flushing) {
      return;
    }
    await new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  async function close() {
    if (closed) {
      return;
    }
    await flushPending();
    closed = true;
  }

  return {
    close,
    flushPending,
    markDirty
  };
}

module.exports = {
  createStatusCheckpointWriter
};
