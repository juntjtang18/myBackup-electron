(function initProgressPanel(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.myBackupProgressPanel = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : window, function createProgressPanelModule() {
  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes <= 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function safeDomId(value) {
    return String(value || 'progress')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'progress';
  }

  function normalizeQueue(queue, pool) {
    const isHash = pool === 'hash';
    const isFile = pool === 'file';
    const normalized = {
      depth: Number(queue?.depth || 0),
      pending: Number(queue?.pending || 0),
      active: Number(queue?.active || 0),
      waitingItems: Array.isArray(queue?.waitingItems) ? queue.waitingItems : [],
      activeItems: Array.isArray(queue?.activeItems) ? queue.activeItems : [],
      feedItems: isHash && Array.isArray(queue?.feedItems) ? queue.feedItems : [],
      handoffItems: !isHash && !isFile && Array.isArray(queue?.handoffItems) ? queue.handoffItems : []
    };
    return normalized;
  }

  function workerSortKey(worker) {
    const id = String(worker.workerId || '');
    const match = id.match(/(\d+)$/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  function normalizeWorker(worker, pool) {
    return {
      workerId: worker.workerId || '',
      pool,
      state: worker.state || 'idle',
      sourceRelativePath: worker.sourceRelativePath || null,
      logicalPath: (pool === 'copy' || pool === 'file') ? (worker.logicalPath || null) : null,
      lastAction: worker.lastAction || null,
      copiedBytes: Number(worker.copiedBytes || 0),
      totalBytes: Number(worker.totalBytes || 0),
      error: worker.error || null
    };
  }

  function normalizeWorkers(workersByKey, pool) {
    return Object.values(workersByKey || {})
      .filter((worker) => worker && worker.pool === pool)
      .map((worker) => normalizeWorker(worker, pool))
      .sort((left, right) => {
        const byNumber = workerSortKey(left) - workerSortKey(right);
        if (byNumber !== 0) {
          return byNumber;
        }
        return String(left.workerId).localeCompare(String(right.workerId));
      });
  }

  function createProgressViewModel(entry) {
    const progress = entry?.progress || {};
    const hasFilePool = Object.values(progress.workers || {}).some((worker) => worker?.pool === 'file')
      || Boolean(progress.queues?.file);
    if (hasFilePool) {
      return {
        summary: {
          status: progress.status || 'running',
          pausePhase: progress.pausePhase || null,
          filesProcessed: Number(progress.filesProcessed || 0),
          filesCopied: Number(progress.filesCopied || 0),
          throughputBytesPerSecond: Number(
            progress.throughputBytesPerSecond
            || progress.copyThroughputBytesPerSecond
            || progress.hashThroughputBytesPerSecond
            || 0
          )
        },
        pools: {
          file: {
            pool: 'file',
            title: 'Workers',
            queueTitle: 'Queue',
            emptyWorkersText: 'No workers active.',
            emptyQueueText: 'No backlog right now.',
            workers: normalizeWorkers(progress.workers, 'file'),
            queue: normalizeQueue(progress.queues?.file, 'file')
          }
        }
      };
    }
    return {
      summary: {
        status: progress.status || 'running',
        pausePhase: progress.pausePhase || null,
        filesProcessed: Number(progress.filesProcessed || 0),
        filesCopied: Number(progress.filesCopied || 0),
        hashThroughputBytesPerSecond: Number(progress.hashThroughputBytesPerSecond || 0),
        copyThroughputBytesPerSecond: Number(progress.copyThroughputBytesPerSecond || 0)
      },
      pools: {
        hash: {
          pool: 'hash',
          title: 'Hash Workers',
          queueTitle: 'Hash Queue',
          emptyWorkersText: 'No hash workers active.',
          emptyQueueText: 'No hash backlog right now.',
          workers: normalizeWorkers(progress.workers, 'hash'),
          queue: normalizeQueue(progress.queues?.hash, 'hash')
        },
        copy: {
          pool: 'copy',
          title: 'Copy Workers',
          queueTitle: 'Copy Queue',
          emptyWorkersText: 'No copy workers active.',
          emptyQueueText: 'No copy backlog right now.',
          workers: normalizeWorkers(progress.workers, 'copy'),
          queue: normalizeQueue(progress.queues?.copy, 'copy')
        }
      }
    };
  }

  function normalizeProgress(entry) {
    const view = createProgressViewModel(entry);
    if (view.pools.file) {
      return {
        summary: view.summary,
        fileProgress: {
          workers: view.pools.file.workers.map((worker, index) => ({ worker, slot: index + 1 })),
          queue: view.pools.file.queue
        },
        hashProgress: {
          workers: [],
          queue: normalizeQueue(null, 'hash')
        },
        copyProgress: {
          workers: [],
          queue: normalizeQueue(null, 'copy')
        }
      };
    }
    return {
      summary: view.summary,
      hashProgress: {
        workers: view.pools.hash.workers.map((worker, index) => ({ worker, slot: index + 1 })),
        queue: view.pools.hash.queue
      },
      copyProgress: {
        workers: view.pools.copy.workers.map((worker, index) => ({ worker, slot: index + 1 })),
        queue: view.pools.copy.queue
      }
    };
  }

  function formatWorkerLabel(pool, workerId) {
    const prefix = pool === 'hash' ? 'H' : (pool === 'copy' ? 'C' : 'W');
    const id = String(workerId || '');
    const match = id.match(/(\d+)$/);
    return match ? `${prefix}${match[1]}` : `${prefix}`;
  }

  function workerProgress(worker) {
    const totalBytes = worker.totalBytes || 0;
    const copiedBytes = worker.copiedBytes || 0;
    return totalBytes > 0 ? Math.min(100, Math.round((copiedBytes / totalBytes) * 100)) : 0;
  }

  function hashWorkerDisplayName(worker) {
    if (worker.sourceRelativePath) {
      return worker.sourceRelativePath;
    }
    if (worker.lastAction === 'indexed-existing') {
      return 'indexed existing';
    }
    if (worker.lastAction === 'indexed-alias') {
      return 'indexed alias';
    }
    return worker.state === 'idle' ? 'idle' : worker.state;
  }

  function hashWorkerByteLabel(worker) {
    if (worker.lastAction === 'indexed-existing' || worker.lastAction === 'indexed-alias') {
      return 'indexed';
    }
    return worker.state === 'hashing' ? 'hashed' : 'processed';
  }

  function copyWorkerDisplayName(worker) {
    return worker.logicalPath || worker.sourceRelativePath || worker.lastAction || (worker.state === 'idle' ? 'idle' : worker.state);
  }

  function fileWorkerDisplayName(worker) {
    return worker.sourceRelativePath || worker.logicalPath || worker.lastAction || (worker.state === 'idle' ? 'idle' : worker.state);
  }

  function renderWorkerLine(pool, worker) {
    const isHash = pool === 'hash';
    const isFile = pool === 'file';
    const percent = workerProgress(worker);
    const displayName = isHash ? hashWorkerDisplayName(worker) : (isFile ? fileWorkerDisplayName(worker) : copyWorkerDisplayName(worker));
    const byteLabel = isHash ? hashWorkerByteLabel(worker) : 'copied';
    const isIdle = worker.state === 'idle' && !worker.sourceRelativePath && (!worker.logicalPath || isHash);
    return `
      <div class="worker-line worker-line-${pool}${isIdle ? ' worker-line-idle' : ''}">
        <span class="worker-type worker-type-${pool}" title="${escapeHtml(pool)}">${escapeHtml(formatWorkerLabel(pool, worker.workerId))}</span>
        <div class="worker-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
        <div class="worker-progress" title="${escapeHtml(byteLabel)}"><div class="worker-progress-fill" style="width: ${percent}%"></div></div>
        <div class="worker-bytes">${escapeHtml(byteLabel)} ${formatBytes(worker.copiedBytes)} / ${formatBytes(worker.totalBytes)}</div>
      </div>
    `;
  }

  function queueItemName(pool, item) {
    if (pool === 'hash') {
      return item.sourceRelativePath || '-';
    }
    return item.logicalPath || item.sourceRelativePath || '-';
  }

  function renderQueueSection(pool, section, waitingCount) {
    const itemLines = section.items.map((item) => `
      <div class="queue-line queue-line-${pool}">
        <div class="queue-name" title="${escapeHtml(queueItemName(pool, item))}">${escapeHtml(queueItemName(pool, item))}</div>
        <div class="queue-bytes">${formatBytes(item.totalBytes || 0)}</div>
      </div>
    `).join('');
    const extraCount = Math.max(0, waitingCount - (section.waiting ? section.items.length : 0));
    const moreLine = section.waiting && extraCount > 0
      ? `<div class="queue-more">+ ${extraCount} more waiting</div>`
      : '';
    return `
      <div class="queue-section queue-section-${pool}">
        <div class="queue-section-title">${escapeHtml(section.title)}</div>
        <div class="queue-list">${itemLines}${moreLine}</div>
      </div>
    `;
  }

  function queueSections(pool, queue) {
    if (pool === 'file') {
      return [
        { title: 'Waiting', items: queue.waitingItems || [], waiting: true },
        { title: 'Processing', items: queue.activeItems || [] }
      ].filter((section) => section.items.length > 0);
    }
    if (pool === 'hash') {
      return [
        { title: 'Awaiting hash', items: queue.feedItems || [] },
        { title: 'Waiting for hash worker', items: queue.waitingItems || [], waiting: true },
        { title: 'Hashing now', items: queue.activeItems || [] }
      ].filter((section) => section.items.length > 0);
    }
    return [
      { title: 'Waiting for copy worker', items: queue.waitingItems || [], waiting: true },
      { title: 'Copying now', items: queue.activeItems || [] },
      { title: 'Hashed, awaiting copy', items: queue.handoffItems || [] }
    ].filter((section) => section.items.length > 0);
  }

  function renderQueue(poolView) {
    const queue = poolView.queue;
    const waitingCount = queue.depth || 0;
    const activeCount = queue.active || 0;
    const pendingCount = queue.pending || 0;
    const sections = queueSections(poolView.pool, queue);
    return `
      <div class="queue-header queue-header-${poolView.pool}">
        <span class="queue-title">${escapeHtml(poolView.queueTitle)}</span>
        <span class="queue-counts">pending ${pendingCount} · waiting ${waitingCount} · active ${activeCount}</span>
      </div>
      ${sections.length === 0
        ? `<div class="queue-empty">${escapeHtml(poolView.emptyQueueText)}</div>`
        : sections.map((section) => renderQueueSection(poolView.pool, section, waitingCount)).join('')}
    `;
  }

  function renderPoolPanel(poolView, safeKey) {
    const workerLines = poolView.workers.length > 0
      ? poolView.workers.map((worker) => renderWorkerLine(poolView.pool, worker)).join('')
      : `<div class="queue-empty">${escapeHtml(poolView.emptyWorkersText)}</div>`;
    return `
      <section class="progress-pool progress-pool-${poolView.pool}" id="progress-${poolView.pool}-${safeKey}" data-progress-pool="${poolView.pool}" aria-label="${escapeHtml(poolView.title)}">
        <div class="pool-heading pool-heading-${poolView.pool}">${escapeHtml(poolView.title)}</div>
        <div class="worker-list worker-list-${poolView.pool}" id="${poolView.pool}-workers-${safeKey}">${workerLines}</div>
        <div class="queue-block queue-block-${poolView.pool}" id="${poolView.pool}-queue-${safeKey}">${renderQueue(poolView)}</div>
      </section>
    `;
  }

  function renderSummary(summary) {
    const throughput = Number(
      summary.throughputBytesPerSecond
      || summary.copyThroughputBytesPerSecond
      || summary.hashThroughputBytesPerSecond
      || 0
    );
    const throughputMb = Math.round((throughput / (1024 * 1024)) * 10) / 10;
    return `
      <div class="progress-summary">
        <span><strong>Status</strong> ${escapeHtml(summary.status)}${summary.pausePhase ? ` (${escapeHtml(summary.pausePhase)})` : ''}</span>
        <span><strong>Files</strong> ${summary.filesProcessed}</span>
        <span><strong>Copied</strong> ${summary.filesCopied}</span>
        <span><strong>Speed</strong> ${throughputMb} MB/s</span>
      </div>
    `;
  }

  function renderBackupProgressPanel(input) {
    const entry = input.entry;
    if (!entry || !entry.progress) {
      return '';
    }

    const progressKey = input.progressKey || `${input.targetRoot || ''}::${input.source?.machineId || ''}::${input.source?.sourceId || ''}`;
    const safeKey = safeDomId(progressKey);
    const view = createProgressViewModel(entry);
    return `
      <tr class="source-progress-row">
        <td colspan="5">
          <div class="source-progress-panel" id="progress-panel-${safeKey}">
            ${renderSummary(view.summary)}
            <div class="progress-pools">
              ${renderPoolPanel(view.pools.file || view.pools.hash, safeKey)}
            </div>
          </div>
        </td>
      </tr>
    `;
  }

  function shouldRenderImmediatelyForProgress(payload) {
    const eventType = payload?.event?.type;
    const eventPool = payload?.event?.pool;
    return eventType === 'backup-paused'
      || eventType === 'backup-completed'
      || eventType === 'backup-started'
      || eventType === 'copy-progress'
      || eventType === 'file-progress'
      || ((eventPool === 'copy' || eventPool === 'file') && (eventType === 'task-started' || eventType === 'task-completed'))
      || payload?.progress?.status === 'paused';
  }

  return {
    createProgressViewModel,
    normalizeProgress,
    renderBackupProgressPanel,
    renderPoolPanel,
    shouldRenderImmediatelyForProgress
  };
}));
