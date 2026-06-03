const state = {
  dashboard: {
    logLevel: 'info',
    targets: []
  },
  addSourceTargetRoot: null,
  logs: [],
  backupProgress: {},
  pauseRequests: {},
  workerDisplayOrder: {}
};

function progressKey(targetRoot, machineId, sourceId) {
  return `${targetRoot}::${machineId}::${sourceId}`;
}

function progressKeyFromPayload(payload) {
  return progressKey(payload.targetRoot, payload.machineId, payload.sourceId);
}

function pathBasename(value) {
  const parts = String(value || '').split(/[/\\]/);
  return parts[parts.length - 1] || value || 'target';
}

const TARGET_HEADER_ICON = `
  <span class="target-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V7.5z"></path>
    </svg>
  </span>
`;

function formatTargetHeaderLabel(targetPath, maxLength = 60) {
  const name = pathBasename(targetPath);
  const path = String(targetPath || '');
  const combined = `${name} · ${path}`;

  if (combined.length <= maxLength) {
    return {
      name,
      path,
      truncated: false
    };
  }

  const sep = ' · ';
  const budget = maxLength - 1;
  const minName = Math.min(name.length, 12);
  let nameLen = minName;
  let pathLen = budget - sep.length - nameLen;

  if (pathLen < 8) {
    nameLen = Math.max(4, budget - sep.length - 8);
    pathLen = budget - sep.length - nameLen;
  }

  return {
    name: name.slice(0, nameLen),
    path: `${path.slice(0, Math.max(0, pathLen))}…`,
    truncated: true
  };
}

function renderTargetHeaderLabel(targetPath) {
  const parts = formatTargetHeaderLabel(targetPath);
  return `
    <span class="target-panel-label-name">${escapeHtml(parts.name)}</span><span class="target-panel-label-sep"> · </span><span class="target-panel-label-path">${escapeHtml(parts.path)}</span>
  `;
}

function targetHasActiveBackup(target) {
  return (target.sources || []).some((source) => (
    state.backupProgress[progressKey(target.path, source.machineId, source.sourceId)]
  ));
}

let progressRenderTimer = null;
const PROGRESS_RENDER_MS = 200;

function scheduleProgressRender() {
  if (progressRenderTimer) {
    return;
  }

  progressRenderTimer = window.setTimeout(() => {
    progressRenderTimer = null;
    renderSources();
  }, PROGRESS_RENDER_MS);
}

function flushProgressRender() {
  if (progressRenderTimer) {
    window.clearTimeout(progressRenderTimer);
    progressRenderTimer = null;
  }
  renderSources();
}

function clearWorkerDisplayOrder(progressKey) {
  delete state.workerDisplayOrder[progressKey];
}

function ensureWorkerDisplayOrder(progressKey, workers) {
  if (!state.workerDisplayOrder[progressKey]) {
    state.workerDisplayOrder[progressKey] = { hash: [], copy: [] };
  }

  const order = state.workerDisplayOrder[progressKey];
  for (const worker of Object.values(workers || {})) {
    const slotList = order[worker.pool];
    if (!slotList || slotList.includes(worker.workerId)) {
      continue;
    }
    slotList.push(worker.workerId);
  }
}

function orderWorkersForDisplay(pool, workers, slotOrder) {
  const byId = new Map();
  for (const worker of workers) {
    if (worker.pool === pool) {
      byId.set(worker.workerId, worker);
    }
  }

  return slotOrder.map((workerId, index) => {
    const worker = byId.get(workerId);
    if (worker) {
      return { worker, slot: index + 1 };
    }

    return {
      worker: {
        workerId,
        pool,
        state: 'idle',
        sourceRelativePath: null,
        logicalPath: null,
        copiedBytes: 0,
        totalBytes: 0
      },
      slot: index + 1
    };
  });
}

function formatTimestamp(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function appendLog(level, message, details) {
  state.logs.unshift({
    level,
    message,
    details,
    timestamp: new Date().toISOString()
  });
  state.logs = state.logs.slice(0, 40);
  renderLogs();
}

function setBusy(button, busy, label) {
  if (!button) {
    return;
  }

  button.disabled = busy;
  if (label) {
    button.dataset.label = button.dataset.label || button.textContent;
    button.textContent = busy ? label : button.dataset.label;
  }
}

function renderLogs() {
  const logList = document.getElementById('logList');
  if (!logList) {
    return;
  }

  if (state.logs.length === 0) {
    logList.innerHTML = '<li class="log-empty">No activity yet.</li>';
    return;
  }

  logList.innerHTML = state.logs.map((entry) => {
    const date = new Date(entry.timestamp);
    const time = Number.isNaN(date.getTime())
      ? '--:--:--'
      : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const level = entry.level.toUpperCase();
    const detailSuffix = entry.details ? ` ${JSON.stringify(entry.details)}` : '';
    return `
      <li class="log-line" title="${escapeHtml(entry.message + detailSuffix)}">
        <span class="log-time">${escapeHtml(time)}</span>
        <span class="log-level log-level-${escapeHtml(entry.level)}">${escapeHtml(level)}</span>
        <span class="log-msg">${escapeHtml(entry.message)}${entry.details ? `<span class="muted"> ${escapeHtml(JSON.stringify(entry.details))}</span>` : ''}</span>
      </li>
    `;
  }).join('');
}

function scanBadgeClass(status) {
  if (status === 'running' || status === 'pausing') {
    return 'scan-badge-running';
  }
  if (status === 'paused') {
    return 'scan-badge-paused';
  }
  if (status === 'completed') {
    return 'scan-badge-completed';
  }
  return 'scan-badge-idle';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderProgressPanel(targetRoot, source) {
  const key = progressKey(targetRoot, source.machineId, source.sourceId);
  const entry = state.backupProgress[key];
  if (!entry || !entry.progress) {
    return '';
  }

  const workers = Object.values(entry.progress.workers || {});
  ensureWorkerDisplayOrder(key, entry.progress.workers || {});
  const workerOrder = state.workerDisplayOrder[key] || { hash: [], copy: [] };
  const hashWorkers = orderWorkersForDisplay('hash', workers, workerOrder.hash);
  const copyWorkers = orderWorkersForDisplay('copy', workers, workerOrder.copy);

  const hashQueue = entry.progress.queues?.hash || {
    depth: 0, pending: 0, active: 0, waitingItems: [], activeItems: [], feedItems: []
  };
  const copyQueue = entry.progress.queues?.copy || {
    depth: 0, pending: 0, active: 0, waitingItems: [], activeItems: [], handoffItems: []
  };

  const hashThroughput = Math.round(((entry.progress.hashThroughputBytesPerSecond || 0) / (1024 * 1024)) * 10) / 10;
  const copyThroughput = Math.round(((entry.progress.copyThroughputBytesPerSecond || 0) / (1024 * 1024)) * 10) / 10;

  function renderWorkerLine(worker, slot, prefix) {
    const totalBytes = worker.totalBytes || 0;
    const copiedBytes = worker.copiedBytes || 0;
    const percent = totalBytes > 0 ? Math.min(100, Math.round((copiedBytes / totalBytes) * 100)) : 0;
    const stateLabel = worker.state === 'idle'
      ? 'idle'
      : (worker.state === 'hashing' ? 'hashing' : (worker.state === 'copying' ? 'copying' : worker.state));
    const isIdle = worker.state === 'idle' && !worker.sourceRelativePath && !worker.logicalPath;
    return `
      <div class="worker-line${isIdle ? ' worker-line-idle' : ''}">
        <span class="worker-type" title="${escapeHtml(worker.pool || 'worker')}">${escapeHtml(`${prefix}${slot}`)}</span>
        <div class="worker-name" title="${escapeHtml(worker.sourceRelativePath || worker.logicalPath || stateLabel)}">${escapeHtml(worker.sourceRelativePath || worker.logicalPath || stateLabel)}</div>
        <div class="worker-progress"><div class="worker-progress-fill" style="width: ${percent}%"></div></div>
        <div class="worker-bytes">${formatBytes(copiedBytes)} / ${formatBytes(totalBytes)}</div>
      </div>
    `;
  }

  function renderQueueSection(label, queue, emptyLabel) {
    const waitingCount = queue.depth || 0;
    const activeCount = queue.active || 0;
    const pendingCount = queue.pending || 0;
    const feedCount = (queue.feedItems || []).length;
    const handoffCount = (queue.handoffItems || []).length;
    const header = `
      <div class="queue-header">
        <span class="queue-title">${escapeHtml(label)}</span>
        <span class="queue-counts">
          pending ${pendingCount}
          · waiting ${waitingCount}
          · active ${activeCount}
          ${feedCount > 0 ? ` · feed ${feedCount}` : ''}
          ${handoffCount > 0 ? ` · handoff ${handoffCount}` : ''}
        </span>
      </div>
    `;

    const sections = [];
    if (queue.feedItems && queue.feedItems.length > 0) {
      sections.push({ title: 'Awaiting hash', items: queue.feedItems });
    }
    if (queue.waitingItems && queue.waitingItems.length > 0) {
      sections.push({ title: 'Waiting for worker', items: queue.waitingItems });
    }
    if (queue.activeItems && queue.activeItems.length > 0) {
      sections.push({ title: 'In progress', items: queue.activeItems });
    }
    if (queue.handoffItems && queue.handoffItems.length > 0) {
      sections.push({ title: 'Hashed, awaiting copy', items: queue.handoffItems });
    }

    if (sections.length === 0) {
      return `${header}<div class="queue-empty">${escapeHtml(emptyLabel)}</div>`;
    }

    const sectionHtml = sections.map((section) => {
      const itemLines = section.items.map((item) => `
        <div class="queue-line">
          <div class="queue-name" title="${escapeHtml(item.sourceRelativePath || item.logicalPath || '-')}">${escapeHtml(item.sourceRelativePath || item.logicalPath || '-')}</div>
          <div class="queue-bytes">${formatBytes(item.totalBytes || 0)}</div>
        </div>
      `).join('');
      const extraCount = Math.max(0, waitingCount - (queue.waitingItems || []).length);
      const moreLine = section.title === 'Waiting for worker' && extraCount > 0
        ? `<div class="queue-more">+ ${extraCount} more waiting</div>`
        : '';
      return `
        <div class="queue-section">
          <div class="queue-section-title">${escapeHtml(section.title)}</div>
          <div class="queue-list">${itemLines}${moreLine}</div>
        </div>
      `;
    }).join('');

    return `${header}${sectionHtml}`;
  }

  const hashWorkerLines = hashWorkers.length > 0
    ? hashWorkers.map(({ worker, slot }) => renderWorkerLine(worker, slot, 'H')).join('')
    : '<div class="queue-empty">No hash workers active.</div>';
  const copyWorkerLines = copyWorkers.length > 0
    ? copyWorkers.map(({ worker, slot }) => renderWorkerLine(worker, slot, 'C')).join('')
    : '<div class="queue-empty">No copy workers active.</div>';

  return `
    <tr class="source-progress-row">
      <td colspan="5">
        <div class="source-progress-panel">
          <div class="progress-summary">
            <span><strong>Status</strong> ${escapeHtml(entry.progress.status || 'running')}${entry.progress.pausePhase ? ` (${escapeHtml(entry.progress.pausePhase)})` : ''}</span>
            <span><strong>Files</strong> ${entry.progress.filesProcessed || 0}</span>
            <span><strong>Copied</strong> ${entry.progress.filesCopied || 0}</span>
            <span><strong>Hash</strong> ${hashThroughput} MB/s</span>
            <span><strong>Copy</strong> ${copyThroughput} MB/s</span>
          </div>
          <div class="progress-pools">
            <div class="progress-pool">
              <div class="pool-heading">Hash Workers</div>
              <div class="worker-list">${hashWorkerLines}</div>
              ${renderQueueSection('Hash Queue', hashQueue, 'No hash backlog right now.')}
            </div>
            <div class="progress-pool">
              <div class="pool-heading">Copy Workers</div>
              <div class="worker-list">${copyWorkerLines}</div>
              ${renderQueueSection('Copy Queue', copyQueue, 'No copy backlog right now.')}
            </div>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderTargetSourcesTable(targetRoot, sources) {
  if (!sources || sources.length === 0) {
    return '<div class="empty-state" style="padding:24px 12px;margin-top:8px;">No sources in this target. Click <strong>+ Source</strong> to add one.</div>';
  }

  const rows = sources.map((source) => {
    const key = progressKey(targetRoot, source.machineId, source.sourceId);
    const activeProgress = state.backupProgress[key];
    const pauseRequested = state.pauseRequests[key];
    const isPausing = activeProgress?.progress?.status === 'pausing';
    const restoreDisabled = Boolean(activeProgress);
    const backupLabel = activeProgress
      ? (pauseRequested || isPausing ? 'Pausing...' : 'Pause')
      : (source.scanStatus === 'paused' ? 'Resume' : 'Backup');
    const backupClass = activeProgress ? 'btn-outline-warning' : 'btn-outline-primary';
    const mergedRoot = source.mergeEnabled ? source.mergeKey : source.targetSubdir;

    return `
      <tr>
        <td>
          <div class="path-cell">${escapeHtml(source.sourcePath)}</div>
          <div class="mt-2">
            ${source.mergeEnabled ? '<span class="tag tag-merge">Merge</span>' : ''}
            ${source.organizeMedia ? '<span class="tag tag-media">Media</span>' : ''}
          </div>
        </td>
        <td><div class="path-cell">${escapeHtml(mergedRoot)}</div></td>
        <td>
          <span class="scan-badge ${scanBadgeClass(source.scanStatus)}">${escapeHtml(source.scanStatus || 'idle')}</span>
          <div class="small muted mt-1">${escapeHtml(source.activeGeneration || '-')}</div>
        </td>
        <td><div class="small">${escapeHtml(formatTimestamp(source.lastCompletedAt))}</div></td>
        <td>
          <div class="actions-row">
            <button class="btn btn-sm ${backupClass} run-backup-button" data-target-root="${escapeHtml(targetRoot)}" data-machine-id="${escapeHtml(source.machineId)}" data-source-id="${escapeHtml(source.sourceId)}">${backupLabel}</button>
            <button class="btn btn-sm btn-outline-secondary restore-source-button" data-target-root="${escapeHtml(targetRoot)}" data-machine-id="${escapeHtml(source.machineId)}" data-source-id="${escapeHtml(source.sourceId)}"${restoreDisabled ? ' disabled' : ''}>Restore</button>
            ${source.mergeEnabled ? `<button class="btn btn-sm btn-outline-success restore-merged-button" data-target-root="${escapeHtml(targetRoot)}" data-logical-root="${escapeHtml(source.targetSubdir)}"${restoreDisabled ? ' disabled' : ''}>Restore Merged</button>` : ''}
          </div>
        </td>
      </tr>
      ${renderProgressPanel(targetRoot, source)}
    `;
  }).join('');

  return `
    <table class="source-table">
      <thead>
        <tr>
          <th>Source</th>
          <th>Target</th>
          <th>Scan</th>
          <th>Completed</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function bindTargetPanelActions(container) {
  container.querySelectorAll('.target-panel-header').forEach((header) => {
    header.addEventListener('click', (event) => {
      if (event.target.closest('.target-panel-actions')) {
        return;
      }
      toggleTargetPanel(header.dataset.targetId);
    });
  });

  container.querySelectorAll('.add-source-button').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openAddSourceFlow(button.dataset.targetRoot);
    });
  });

  container.querySelectorAll('.remove-target-button').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      removeTarget(button.dataset.targetId, button.dataset.targetRoot);
    });
  });

  container.querySelectorAll('.run-backup-button').forEach((button) => {
    button.addEventListener('click', () => runBackup(
      button.dataset.targetRoot,
      button.dataset.machineId,
      button.dataset.sourceId,
      button
    ));
  });

  container.querySelectorAll('.restore-source-button').forEach((button) => {
    button.addEventListener('click', () => runRestoreSource(
      button.dataset.targetRoot,
      button.dataset.machineId,
      button.dataset.sourceId,
      button
    ));
  });

  container.querySelectorAll('.restore-merged-button').forEach((button) => {
    button.addEventListener('click', () => runRestoreMerged(
      button.dataset.targetRoot,
      button.dataset.logicalRoot,
      button
    ));
  });
}

function renderTargets() {
  const container = document.getElementById('targetsContainer');
  if (!container) {
    return;
  }

  const targets = state.dashboard.targets || [];
  if (targets.length === 0) {
    container.innerHTML = '<div class="empty-state">No backup targets yet. Click <strong>+ Add Target</strong> to choose a folder.</div>';
    return;
  }

  container.innerHTML = targets.map((target) => {
    const sourceCount = (target.sources || []).length;
    const isRunning = targetHasActiveBackup(target);
    const collapsedClass = target.collapsed ? 'collapsed' : '';
    const activeClass = isRunning ? 'is-active' : '';

    return `
      <article class="target-panel ${collapsedClass} ${activeClass}" data-target-id="${escapeHtml(target.id)}">
        <div class="target-panel-header" data-target-id="${escapeHtml(target.id)}">
          <span class="target-chevron" aria-hidden="true">▶</span>
          ${TARGET_HEADER_ICON}
          <div class="target-panel-title">
            <div class="target-panel-label" title="${escapeHtml(target.path)}">${renderTargetHeaderLabel(target.path)}</div>
          </div>
          <div class="target-panel-meta">
            ${isRunning ? '<span class="target-running-dot" title="Backup running"></span>' : ''}
            <span class="target-count-badge">${sourceCount} source${sourceCount === 1 ? '' : 's'}</span>
          </div>
          <div class="target-panel-actions">
            <button type="button" class="btn-target-action add-source-button" data-target-root="${escapeHtml(target.path)}">+ Source</button>
            <button type="button" class="btn-target-action danger remove-target-button" data-target-id="${escapeHtml(target.id)}" data-target-root="${escapeHtml(target.path)}" title="Remove from list">Remove</button>
          </div>
        </div>
        <div class="target-panel-body">
          <div class="sources-wrap">${renderTargetSourcesTable(target.path, target.sources)}</div>
        </div>
      </article>
    `;
  }).join('');

  bindTargetPanelActions(container);
}

function renderSources() {
  renderTargets();
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

function renderDashboard() {
  const logLevelSelect = document.getElementById('logLevelSelect');
  if (logLevelSelect && state.dashboard.logLevel) {
    logLevelSelect.value = state.dashboard.logLevel;
  }
  renderTargets();
}

let addSourceModal = null;

function getAddSourceModal() {
  if (!addSourceModal) {
    addSourceModal = document.getElementById('addSourceModal');
  }
  return addSourceModal;
}

function showAddSourceModal() {
  const modal = getAddSourceModal();
  const label = document.getElementById('addSourceTargetLabel');
  if (label) {
    label.textContent = state.addSourceTargetRoot
      ? `Target: ${state.addSourceTargetRoot}`
      : '';
  }
  if (modal) {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }
}

function hideAddSourceModal() {
  const modal = getAddSourceModal();
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
}

async function refreshDashboard() {
  state.dashboard = await window.myBackup.getDashboard();
  renderDashboard();
}

async function updateLogLevel(event) {
  try {
    state.dashboard = await window.myBackup.setLogLevel({
      level: event.target.value
    });
    renderDashboard();
    appendLog('info', `Log level set to ${event.target.value}.`);
  } catch (error) {
    appendLog('error', error.message || 'Failed to update log level.');
  }
}

async function addTarget() {
  const button = document.getElementById('addTargetButton');
  try {
    setBusy(button, true, 'Adding...');
    state.dashboard = await window.myBackup.addTarget();
    renderDashboard();
  } catch (error) {
    appendLog('error', error.message || 'Failed to add backup target.');
  } finally {
    setBusy(button, false);
  }
}

async function removeTarget(targetId, targetRoot) {
  const hasRunning = Object.keys(state.backupProgress).some((key) => key.startsWith(`${targetRoot}::`));
  if (hasRunning) {
    appendLog('warn', 'Cannot remove a target while a backup is running.');
    return;
  }

  const confirmed = window.confirm(`Remove "${targetRoot}" from the app?\n\nBackup data on disk is not deleted.`);
  if (!confirmed) {
    return;
  }

  try {
    state.dashboard = await window.myBackup.removeTarget({ targetId });
    renderDashboard();
  } catch (error) {
    appendLog('error', error.message || 'Failed to remove backup target.');
  }
}

async function toggleTargetPanel(targetId) {
  const target = (state.dashboard.targets || []).find((entry) => entry.id === targetId);
  const collapsed = target ? !target.collapsed : false;
  try {
    state.dashboard = await window.myBackup.setTargetCollapsed({
      targetId,
      collapsed
    });
    renderDashboard();
  } catch (error) {
    appendLog('error', error.message || 'Failed to update target panel.');
  }
}

async function openAddSourceFlow(targetRoot) {
  if (!targetRoot) {
    appendLog('warn', 'Choose a backup target first.');
    return;
  }

  state.addSourceTargetRoot = targetRoot;
  showAddSourceModal();
}

async function browseSource() {
  try {
    const selectedPath = await window.myBackup.pickSourceFolder();
    if (selectedPath) {
      document.getElementById('sourcePathInput').value = selectedPath;
    }
  } catch (error) {
    appendLog('error', error.message || 'Failed to select source folder.');
  }
}

async function registerSource(event) {
  event.preventDefault();
  const button = document.getElementById('addSourceButton');
  const sourcePath = document.getElementById('sourcePathInput').value.trim();
  const mergeEnabled = document.getElementById('mergeEnabledInput').checked;
  const organizeMedia = document.getElementById('organizeMediaInput').checked;
  const mergeKey = document.getElementById('mergeKeyInput').value.trim();

  if (!sourcePath) {
    appendLog('error', 'Source folder is required.');
    return;
  }

  try {
    setBusy(button, true, 'Registering...');
    state.dashboard = await window.myBackup.addSource({
      targetRoot: state.addSourceTargetRoot,
      sourcePath,
      mergeEnabled,
      organizeMedia,
      mergeKey
    });
    renderDashboard();
    document.getElementById('sourceForm').reset();
    hideAddSourceModal();
  } catch (error) {
    appendLog('error', error.message || 'Failed to register source.');
  } finally {
    setBusy(button, false);
  }
}

async function runBackup(targetRoot, machineId, sourceId, button) {
  const key = progressKey(targetRoot, machineId, sourceId);
  if (state.backupProgress[key]) {
    try {
      state.pauseRequests[key] = true;
      renderSources();
      await window.myBackup.pauseBackup({ targetRoot, machineId, sourceId });
    } catch (error) {
      delete state.pauseRequests[key];
      appendLog('error', error.message || 'Failed to pause backup.');
      renderSources();
    }
    return;
  }

  const target = (state.dashboard.targets || []).find((entry) => entry.path === targetRoot);
  const source = (target?.sources || []).find((entry) => entry.machineId === machineId && entry.sourceId === sourceId);
  if (target && target.collapsed) {
    target.collapsed = false;
    window.myBackup.setTargetCollapsed({ targetId: target.id, collapsed: false }).catch(() => {});
  }
  try {
    state.backupProgress[key] = {
      targetRoot,
      machineId,
      sourceId,
      progress: {
        status: 'running',
        filesProcessed: 0,
        filesCopied: 0,
        workers: {}
      },
      event: null
    };
    renderSources();
    const result = await window.myBackup.runBackup({
      targetRoot,
      machineId,
      sourceId,
      forceNewScan: source && source.scanStatus !== 'paused'
    });
    delete state.backupProgress[key];
    delete state.pauseRequests[key];
    clearWorkerDisplayOrder(key);
    state.dashboard = result.dashboard;
    renderDashboard();
    appendLog('info', result.summary.status === 'paused' ? 'Backup paused.' : 'Backup summary.', result.summary);
  } catch (error) {
    delete state.backupProgress[key];
    delete state.pauseRequests[key];
    clearWorkerDisplayOrder(key);
    renderSources();
    appendLog('error', error.message || 'Backup failed.');
  }
}

async function runRestoreSource(targetRoot, machineId, sourceId, button) {
  try {
    setBusy(button, true, 'Restoring...');
    const summary = await window.myBackup.restoreSource({ targetRoot, machineId, sourceId });
    if (summary) {
      appendLog('info', 'Source restore summary.', summary);
    }
  } catch (error) {
    appendLog('error', error.message || 'Source restore failed.');
  } finally {
    setBusy(button, false);
  }
}

async function runRestoreMerged(targetRoot, logicalRoot, button) {
  try {
    setBusy(button, true, 'Restoring...');
    const summary = await window.myBackup.restoreMerged({ targetRoot, logicalRoot });
    if (summary) {
      appendLog('info', 'Merged restore summary.', summary);
    }
  } catch (error) {
    appendLog('error', error.message || 'Merged restore failed.');
  } finally {
    setBusy(button, false);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('addTargetButton').addEventListener('click', addTarget);
  document.getElementById('closeAddSourceButton').addEventListener('click', hideAddSourceModal);
  document.getElementById('cancelAddSourceButton').addEventListener('click', hideAddSourceModal);
  getAddSourceModal()?.addEventListener('click', (event) => {
    if (event.target === getAddSourceModal()) {
      hideAddSourceModal();
    }
  });
  document.getElementById('browseSourceButton').addEventListener('click', browseSource);
  document.getElementById('sourceForm').addEventListener('submit', registerSource);
  document.getElementById('logLevelSelect').addEventListener('change', updateLogLevel);
  window.myBackup.onBackupProgress((payload) => {
    const key = progressKeyFromPayload(payload);
    state.backupProgress[key] = payload;
    if (payload.progress && payload.progress.status !== 'running' && payload.progress.status !== 'pausing') {
      delete state.pauseRequests[key];
      clearWorkerDisplayOrder(key);
    }
    if (payload.event?.type === 'backup-pausing' && payload.event?.phase) {
      appendLog('info', `Backup pausing: ${payload.event.phase}.`, payload.progress?.queues || null);
    }

    const shouldRenderImmediately = payload.event?.type === 'backup-paused'
      || payload.event?.type === 'backup-completed'
      || payload.event?.type === 'backup-started'
      || payload.progress?.status === 'paused';

    if (shouldRenderImmediately) {
      flushProgressRender();
    } else {
      scheduleProgressRender();
    }
  });
  window.myBackup.onLog((entry) => appendLog(entry.level, entry.message, entry.details));
  await refreshDashboard();
  renderLogs();
});
