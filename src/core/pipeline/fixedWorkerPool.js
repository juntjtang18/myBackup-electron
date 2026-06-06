function createFixedWorkerPool(options) {
  if (!options || !options.queue || typeof options.process !== 'function') {
    throw new Error('queue and process are required.');
  }

  const size = Math.max(1, options.size || 1);
  const prefix = options.prefix || 'W';
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const workers = [];
  let started = false;

  function createWorker(index) {
    const worker = {
      id: `${prefix}${index + 1}`,
      index,
      currentItem: null,
      active: false
    };

    async function loop() {
      onEvent({ type: 'worker-started', workerId: worker.id, worker });
      while (true) {
        const next = await options.queue.take();
        if (next.done) {
          break;
        }

        worker.currentItem = next.value;
        worker.active = true;
        const startedAt = Date.now();
        onEvent({
          type: 'task-started',
          workerId: worker.id,
          worker,
          item: next.value
        });

        try {
          const result = await options.process(next.value, worker);
          onEvent({
            type: 'task-completed',
            workerId: worker.id,
            worker,
            item: next.value,
            result,
            durationMs: Date.now() - startedAt
          });
        } catch (error) {
          onEvent({
            type: 'task-failed',
            workerId: worker.id,
            worker,
            item: next.value,
            error,
            durationMs: Date.now() - startedAt
          });
        } finally {
          worker.currentItem = null;
          worker.active = false;
        }
      }
      onEvent({ type: 'worker-stopped', workerId: worker.id, worker });
    }

    worker.promise = loop();
    return worker;
  }

  function start() {
    if (started) {
      return;
    }
    started = true;
    for (let index = 0; index < size; index += 1) {
      workers.push(createWorker(index));
    }
  }

  async function wait() {
    await Promise.allSettled(workers.map((worker) => worker.promise));
  }

  function snapshot() {
    return {
      size,
      active: workers.filter((worker) => worker.active).length,
      workers: workers.map((worker) => ({
        id: worker.id,
        active: worker.active,
        currentItem: worker.currentItem
      }))
    };
  }

  return {
    snapshot,
    start,
    wait
  };
}

module.exports = {
  createFixedWorkerPool
};
