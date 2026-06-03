function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SchedulerCancelledError extends Error {
  constructor() {
    super('Scheduler cancelled.');
    this.name = 'SchedulerCancelledError';
    this.code = 'PAUSE_CANCELLED';
  }
}

function createWorkScheduler(options) {
  if (!options || typeof options.processTask !== 'function') {
    throw new Error('processTask is required.');
  }

  const scheduler = {
    processTask: options.processTask,
    getTaskBytes: options.getTaskBytes || ((result) => result?.bytesProcessed || 0),
    initialWorkers: Math.max(1, options.initialWorkers || 1),
    maxWorkers: Math.max(1, options.maxWorkers || 1),
    backlogFactor: Math.max(1, options.backlogFactor || 4),
    trialWindowMs: Math.max(1, options.trialWindowMs || 20000),
    throughputImprovementThreshold: options.throughputImprovementThreshold || 1.15,
    now: options.now || (() => Date.now()),
    idleWaitMs: Math.max(1, options.idleWaitMs || 10),
    onWorkerEvent: typeof options.onWorkerEvent === 'function' ? options.onWorkerEvent : null,
    summarizePayload: typeof options.summarizePayload === 'function' ? options.summarizePayload : null,
    queuePreviewLimit: Math.max(1, options.queuePreviewLimit || 20),
    queue: [],
    workers: [],
    acceptedWorkers: 0,
    totalBytes: 0,
    completedTasks: 0,
    totalTaskDurationMs: 0,
    trial: null,
    scalingLocked: false,
    closed: false,
    startedAt: null,
    pendingTasks: 0
  };

  scheduler.startedAt = scheduler.now();

  function throughputSince(startedAt, bytesAtStart) {
    const elapsedMs = scheduler.now() - startedAt;
    if (elapsedMs <= 0) {
      return 0;
    }

    return (scheduler.totalBytes - bytesAtStart) / (elapsedMs / 1000);
  }

  function overallThroughput() {
    return throughputSince(scheduler.startedAt, 0);
  }

  function removeRetiredWorkers() {
    scheduler.workers = scheduler.workers.filter((worker) => !worker.exited);
  }

  function maybeRetireWorker(worker) {
    if (worker.retireAfterTask) {
      worker.shouldStop = true;
      worker.retireAfterTask = false;
      return true;
    }

    return false;
  }

  async function workerLoop(worker) {
    while (true) {
      if (worker.shouldStop) {
        break;
      }

      const item = scheduler.queue.shift();
      if (!item) {
        if (scheduler.closed && scheduler.pendingTasks === 0) {
          break;
        }
        await sleep(scheduler.idleWaitMs);
        continue;
      }

      const startedAt = scheduler.now();
      worker.currentPayload = item.payload;
      if (scheduler.onWorkerEvent) {
        scheduler.onWorkerEvent({
          type: 'task-started',
          workerId: worker.id,
          payload: item.payload,
          snapshot: snapshot()
        });
      }
      try {
        const result = await scheduler.processTask(item.payload, {
          workerId: worker.id
        });
        const durationMs = Math.max(0, scheduler.now() - startedAt);
        const bytesProcessed = Math.max(0, scheduler.getTaskBytes(result, item.payload) || 0);
        scheduler.completedTasks += 1;
        scheduler.totalBytes += bytesProcessed;
        scheduler.totalTaskDurationMs += durationMs;
        if (scheduler.onWorkerEvent) {
          scheduler.onWorkerEvent({
            type: 'task-completed',
            workerId: worker.id,
            payload: item.payload,
            result,
            snapshot: snapshot()
          });
        }
        item.resolve(result);
      } catch (error) {
        if (scheduler.onWorkerEvent) {
          scheduler.onWorkerEvent({
            type: 'task-failed',
            workerId: worker.id,
            payload: item.payload,
            error: {
              message: error.message
            },
            snapshot: snapshot()
          });
        }
        item.reject(error);
      } finally {
        worker.currentPayload = null;
        scheduler.pendingTasks -= 1;
      }

      evaluateTrial();
      if (maybeRetireWorker(worker)) {
        break;
      }
      maybeStartTrial();
    }

    worker.exited = true;
  }

  function startWorker({ accepted = false } = {}) {
    const worker = {
      id: `worker-${scheduler.workers.length + 1}-${scheduler.now()}`,
      retireAfterTask: false,
      shouldStop: false,
      exited: false,
      accepted,
      currentPayload: null
    };
    scheduler.workers.push(worker);
    if (scheduler.onWorkerEvent) {
      scheduler.onWorkerEvent({
        type: 'worker-started',
        workerId: worker.id,
        accepted,
        snapshot: snapshot()
      });
    }
    worker.promise = workerLoop(worker);
    return worker;
  }

  function queuedItems() {
    if (!scheduler.summarizePayload) {
      return [];
    }

    return scheduler.queue
      .slice(0, scheduler.queuePreviewLimit)
      .map((item) => scheduler.summarizePayload(item.payload));
  }

  function inFlightCount() {
    return scheduler.workers.filter((worker) => !worker.exited && worker.currentPayload).length;
  }

  function inFlightItems() {
    if (!scheduler.summarizePayload) {
      return [];
    }

    return scheduler.workers
      .filter((worker) => !worker.exited && worker.currentPayload)
      .slice(0, scheduler.queuePreviewLimit)
      .map((worker) => scheduler.summarizePayload(worker.currentPayload));
  }

  function snapshot() {
    return {
      activeWorkers: activeWorkers(),
      acceptedWorkers: scheduler.acceptedWorkers,
      queueDepth: scheduler.queue.length,
      pendingTasks: scheduler.pendingTasks,
      inFlightCount: inFlightCount(),
      queuedItems: queuedItems(),
      inFlightItems: inFlightItems(),
      completedTasks: scheduler.completedTasks,
      totalBytes: scheduler.totalBytes,
      totalTaskDurationMs: scheduler.totalTaskDurationMs,
      throughputBytesPerSecond: overallThroughput(),
      trialActive: Boolean(scheduler.trial),
      scalingLocked: scheduler.scalingLocked
    };
  }

  function activeWorkers() {
    removeRetiredWorkers();
    return scheduler.workers.filter((worker) => !worker.exited).length;
  }

  function markTrialFailed() {
    if (!scheduler.trial) {
      return;
    }

    scheduler.trial.worker.retireAfterTask = true;
    scheduler.scalingLocked = true;
    if (scheduler.onWorkerEvent) {
      scheduler.onWorkerEvent({
        type: 'trial-rejected',
        workerId: scheduler.trial.worker.id,
        snapshot: snapshot()
      });
    }
    scheduler.trial = null;
  }

  function evaluateTrial() {
    if (!scheduler.trial) {
      return;
    }

    const elapsedMs = scheduler.now() - scheduler.trial.startedAt;
    if (elapsedMs < scheduler.trialWindowMs) {
      return;
    }

    const afterThroughput = throughputSince(
      scheduler.trial.startedAt,
      scheduler.trial.bytesAtStart
    );
    const baseline = scheduler.trial.beforeThroughput;
    if (baseline > 0 && afterThroughput >= baseline * scheduler.throughputImprovementThreshold) {
      scheduler.acceptedWorkers += 1;
      scheduler.trial.worker.accepted = true;
      if (scheduler.onWorkerEvent) {
        scheduler.onWorkerEvent({
          type: 'trial-accepted',
          workerId: scheduler.trial.worker.id,
          snapshot: snapshot()
        });
      }
      scheduler.trial = null;
      return;
    }

    markTrialFailed();
  }

  function maybeStartTrial() {
    if (scheduler.scalingLocked || scheduler.trial) {
      return false;
    }

    const workers = activeWorkers();
    if (workers >= scheduler.maxWorkers) {
      return false;
    }

    if (scheduler.queue.length < workers * scheduler.backlogFactor) {
      return false;
    }

    const baseline = overallThroughput();
    if (baseline <= 0) {
      return false;
    }

    const worker = startWorker({ accepted: false });
    scheduler.trial = {
      worker,
      startedAt: scheduler.now(),
      bytesAtStart: scheduler.totalBytes,
      beforeThroughput: baseline
    };
    if (scheduler.onWorkerEvent) {
      scheduler.onWorkerEvent({
        type: 'trial-started',
        workerId: worker.id,
        snapshot: snapshot()
      });
    }
    return true;
  }

  function startInitialWorkers() {
    for (let index = 0; index < scheduler.initialWorkers; index += 1) {
      startWorker({ accepted: true });
      scheduler.acceptedWorkers += 1;
    }
  }

  queueMicrotask(startInitialWorkers);

  return {
    async push(payload) {
      if (scheduler.closed) {
        throw new Error('Scheduler is closed.');
      }

      scheduler.pendingTasks += 1;
      const taskPromise = new Promise((resolve, reject) => {
        scheduler.queue.push({ payload, resolve, reject });
      });

      maybeStartTrial();
      return taskPromise;
    },
    async closeAndDrain() {
      scheduler.closed = true;

      while (scheduler.pendingTasks > 0 || scheduler.queue.length > 0) {
        evaluateTrial();
        await sleep(scheduler.idleWaitMs);
      }

      if (scheduler.trial) {
        evaluateTrial();
        if (scheduler.trial) {
          markTrialFailed();
        }
      }

      for (const worker of scheduler.workers) {
        worker.shouldStop = true;
      }

      await Promise.all(scheduler.workers.map((worker) => worker.promise));
    },
    async closeAndCancel() {
      scheduler.closed = true;

      while (scheduler.queue.length > 0) {
        const item = scheduler.queue.shift();
        scheduler.pendingTasks -= 1;
        item.reject(new SchedulerCancelledError());
      }

      while (scheduler.pendingTasks > 0) {
        evaluateTrial();
        await sleep(scheduler.idleWaitMs);
      }

      if (scheduler.trial) {
        evaluateTrial();
        if (scheduler.trial) {
          markTrialFailed();
        }
      }

      for (const worker of scheduler.workers) {
        worker.shouldStop = true;
      }

      await Promise.all(scheduler.workers.map((worker) => worker.promise));
    },
    snapshot
  };
}

module.exports = {
  SchedulerCancelledError,
  createWorkScheduler
};
