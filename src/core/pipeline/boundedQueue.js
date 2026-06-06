class QueueCancelledError extends Error {
  constructor() {
    super('Queue cancelled.');
    this.name = 'QueueCancelledError';
    this.code = 'PAUSE_CANCELLED';
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createBoundedQueue(options = {}) {
  const capacity = Math.max(1, options.capacity || 256);
  const name = options.name || 'queue';
  const items = [];
  const takers = [];
  const pushWaiters = [];
  let closed = false;
  let cancelled = false;

  function wakePushers() {
    while (pushWaiters.length > 0 && items.length < capacity) {
      const waiter = pushWaiters.shift();
      waiter.resolve();
    }
  }

  function wakeTakers() {
    while (takers.length > 0 && items.length > 0) {
      const taker = takers.shift();
      const item = items.shift();
      taker.resolve({ done: false, value: item });
      wakePushers();
    }
  }

  async function push(item) {
    if (closed || cancelled) {
      throw new QueueCancelledError();
    }

    while (items.length >= capacity) {
      const waiter = createDeferred();
      pushWaiters.push(waiter);
      await waiter.promise;
      if (closed || cancelled) {
        throw new QueueCancelledError();
      }
    }

    items.push(item);
    wakeTakers();
  }

  async function take() {
    if (items.length > 0) {
      const item = items.shift();
      wakePushers();
      return { done: false, value: item };
    }

    if (closed || cancelled) {
      return { done: true, value: null };
    }

    const waiter = createDeferred();
    takers.push(waiter);
    return waiter.promise;
  }

  function close() {
    closed = true;
    while (takers.length > 0) {
      takers.shift().resolve({ done: true, value: null });
    }
    wakePushers();
  }

  function cancel() {
    cancelled = true;
    closed = true;
    const error = new QueueCancelledError();
    while (pushWaiters.length > 0) {
      pushWaiters.shift().reject(error);
    }
    while (takers.length > 0) {
      takers.shift().resolve({ done: true, value: null });
    }
    const cancelledItems = items.splice(0, items.length);
    return cancelledItems;
  }

  function snapshot() {
    return {
      name,
      depth: items.length,
      closed,
      cancelled
    };
  }

  function preview(limit = 20, mapper = (item) => item) {
    return items.slice(0, limit).map(mapper);
  }

  return {
    cancel,
    close,
    preview,
    push,
    snapshot,
    take
  };
}

module.exports = {
  QueueCancelledError,
  createBoundedQueue
};
