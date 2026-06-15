const state = {
  dashboard: {
    logLevel: 'info',
    targets: []
  },
  addSourceTargetRoot: null,
  logs: [],
  backupProgress: {},
  pauseRequests: {},
  sourceDeleteExpanded: {},
  sourceChangeExpanded: {},
  sourceChanges: {},
  runtimeFlags: {
    traceProgressUi: true,
    showProgressQueueDetails: false
  },
  lastProgressTraceAt: {},
  progressPayloadTraceCount: 0,
  progressRenderTraceCount: 0
};

let lastDashboardPushAt = 0;
const PROGRESS_TRACE_LOG_LIMIT = 160;
let logRenderTimer = null;
const LOG_RENDER_MS = 100;

function progressKey(targetRoot, machineId, sourceId) {
  return `${targetRoot}::${machineId}::${sourceId}`;
}

function sourceChangeKey(targetId, sourceId) {
  return `${targetId}::${sourceId}`;
}

function clearBackupUiState(key) {
  delete state.backupProgress[key];
  delete state.pauseRequests[key];
  delete state.lastProgressTraceAt[key];
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

function summarizeProgressWorker(worker) {
  return {
    id: worker.workerId,
    pool: worker.pool,
    state: worker.state,
    sourceRelativePath: worker.sourceRelativePath || null,
    logicalPath: worker.logicalPath || null,
    lastAction: worker.lastAction || null,
    copiedBytes: worker.copiedBytes || 0,
    totalBytes: worker.totalBytes || 0
  };
}

function summarizeQueue(queue) {
  return {
    depth: queue?.depth || 0,
    pending: queue?.pending || 0,
    active: queue?.active || 0,
    waitingItems: (queue?.waitingItems || []).slice(0, 5),
    activeItems: (queue?.activeItems || []).slice(0, 5)
  };
}

function traceProgressRender(key, payload) {
  if (!payload?.progress || state.progressPayloadTraceCount >= PROGRESS_TRACE_LOG_LIMIT) {
    return;
  }

  state.progressPayloadTraceCount += 1;
  const workers = Object.values(payload.progress.workers || {});
  appendLog('info', 'Progress trace: renderer received payload.', {
    key,
    traceIndex: state.progressPayloadTraceCount,
    sequence: payload.trace?.sequence || null,
    upstreamStage: payload.trace?.stage || null,
    event: payload.event ? {
      type: payload.event.type,
      pool: payload.event.pool || null,
      workerId: payload.event.workerId || null,
      sourceRelativePath: payload.event.sourceRelativePath || null
    } : null,
    status: payload.progress.status || null,
    fileWorkers: workers.filter((worker) => worker.pool === 'file').map(summarizeProgressWorker),
    invalidWorkers: workers.filter((worker) => worker.pool !== 'file').map(summarizeProgressWorker),
    fileQueue: summarizeQueue(payload.progress.queues?.file)
  });
}

function traceProgressPanelRendered(key, entry, html) {
  if (!entry?.progress || !window.myBackupProgressPanel || state.progressRenderTraceCount >= PROGRESS_TRACE_LOG_LIMIT) {
    return;
  }

  state.progressRenderTraceCount += 1;
  const normalized = window.myBackupProgressPanel.normalizeProgress(entry);
  const filePanelStart = html.indexOf('data-progress-pool="file"');
  const filePanelHtml = filePanelStart >= 0 ? html.slice(filePanelStart) : '';

  appendLog('info', 'Progress trace: renderer generated panels.', {
    key,
    traceIndex: state.progressRenderTraceCount,
    sequence: entry.trace?.sequence || null,
    status: normalized.summary.status,
    fileWorkerCount: normalized.fileProgress?.workers.length || 0,
    fileQueueCounts: {
      waiting: normalized.fileProgress?.queue.waitingItems.length || 0,
      active: normalized.fileProgress?.queue.activeItems.length || 0
    },
    htmlChecks: {
      hasFilePanel: filePanelStart >= 0,
      filePanelContainsWorkerId: /W\d+/.test(filePanelHtml),
      filePanelContainsQueueLabel: filePanelHtml.includes('Queue')
    }
  });
}

function formatTimestamp(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '-';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let current = bytes / 1024;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const rounded = current >= 10 ? current.toFixed(0) : current.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

function renderSourceChangePanel(target, source) {
  const key = sourceChangeKey(target.id, source.sourceId);
  if (!state.sourceChangeExpanded[key]) {
    return '';
  }

  const entry = state.sourceChanges[key];
  let body = '<div class="changes-empty">Loading changes...</div>';

  if (entry?.error) {
    body = `<div class="changes-error">${escapeHtml(entry.error)}</div>`;
  } else if (entry?.data) {
    const items = entry.data.items || [];
    if (items.length === 0) {
      body = '<div class="changes-empty">No changes since last backup.</div>';
    } else {
      body = `
        <ul class="changes-list">
          ${items.map((item) => `
            <li class="changes-item">
              <div class="changes-item-path">${escapeHtml(item.relativePath)}</div>
              <div class="changes-item-meta">
                <span>${escapeHtml(formatTimestamp(item.changedAt))}</span>
                <span>${escapeHtml(String(item.eventCount || 0))} event${item.eventCount === 1 ? '' : 's'}</span>
              </div>
            </li>
          `).join('')}
        </ul>
      `;
    }
  }

  return `
    <tr class="source-changes-row">
      <td colspan="5">
        <section class="source-changes-panel">
          <div class="source-changes-header">
            <div class="source-changes-title">Changes since last backup</div>
            <div class="source-changes-meta">${entry?.data?.generatedAt ? escapeHtml(formatTimestamp(entry.data.generatedAt)) : ''}</div>
          </div>
          ${body}
        </section>
      </td>
    </tr>
  `;
}

function formatLogEntryPlain(entry) {
  const details = entry.details === undefined || entry.details === null
    ? ''
    : ` ${JSON.stringify(entry.details)}`;
  return `[${entry.timestamp}][${String(entry.level || 'info').toUpperCase()}] ${entry.message}${details}`;
}

function getLogsPlainText() {
  return state.logs
    .slice()
    .reverse()
    .map(formatLogEntryPlain)
    .join('\n');
}

function appendLog(level, message, details) {
  const entry = {
    level,
    message,
    details,
    timestamp: new Date().toISOString()
  };
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, state.runtimeFlags.traceProgressUi ? 400 : 40);
  scheduleLogRender();
}

function scheduleLogRender() {
  if (logRenderTimer) {
    return;
  }

  logRenderTimer = window.setTimeout(() => {
    logRenderTimer = null;
    renderLogs();
  }, LOG_RENDER_MS);
}

function flushLogRender() {
  if (logRenderTimer) {
    window.clearTimeout(logRenderTimer);
    logRenderTimer = null;
  }
  renderLogs();
}

async function copyLogsToClipboard() {
  flushLogRender();
  const status = document.getElementById('logCopyStatus');
  const text = getLogsPlainText();
  if (!text) {
    if (status) {
      status.textContent = 'No logs';
    }
    return;
  }

  try {
    await window.myBackup.copyText(text);
    if (status) {
      status.textContent = 'Copied';
      window.setTimeout(() => {
        status.textContent = '';
      }, 1800);
    }
  } catch (error) {
    if (status) {
      status.textContent = 'Failed';
    }
    appendLog('error', 'Failed to copy logs.', { message: error.message });
  }
}

function setBusy(button, busy, label) {
  if (!button) {
    return;
  }

  button.disabled = busy;
  if (!button.dataset.label) {
    button.dataset.label = button.textContent;
  }

  if (busy) {
    if (label) {
      button.textContent = label;
    }
  } else {
    button.textContent = button.dataset.label;
  }
}

function nextUiFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
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
  if (!entry || !entry.progress || !window.myBackupProgressPanel) {
    return '';
  }

  const html = window.myBackupProgressPanel.renderBackupProgressPanel({
    targetRoot,
    source,
    entry,
    progressKey: key,
    showProgressQueueDetails: Boolean(state.runtimeFlags.showProgressQueueDetails)
  });
  traceProgressPanelRendered(key, entry, html);
  return html;
}

function renderTargetSourcesTable(target) {
  const targetRoot = target.path;
  const sources = target.sources || [];
  const showDeleteButtons = Boolean(state.sourceDeleteExpanded[target.id]);
  const targetUnavailable = target.available === false;

  if (!sources || sources.length === 0) {
    return '<div class="empty-state" style="padding:24px 12px;margin-top:8px;">No sources in this target. Click <strong>+ Source</strong> to add one.</div>';
  }

  const rows = sources.map((source) => {
    const key = progressKey(targetRoot, source.machineId, source.sourceId);
    const changeKey = sourceChangeKey(target.id, source.sourceId);
    const activeProgress = state.backupProgress[key];
    const pauseRequested = state.pauseRequests[key];
    const isPausing = activeProgress?.progress?.status === 'pausing';
    const pausedCursor = source.backupStatus?.status === 'paused';
    const missingSourceSize = source.sourceSizeBytes === null || source.sourceSizeBytes === undefined;
    const requiresFullBackup = !source.baselineAt
      || missingSourceSize
      || Boolean(source.watchState?.needsRescan);
    const sourceStatus = activeProgress
      ? (isPausing ? 'pausing' : (activeProgress.progress?.status || 'running'))
      : (pausedCursor ? 'paused' : (requiresFullBackup ? 'full backup required' : 'ready'));
    const restoreDisabled = Boolean(activeProgress);
    const deleteDisabled = Boolean(activeProgress);
    const backupLabel = activeProgress
      ? (pauseRequested || isPausing ? 'Pausing...' : 'Pause')
      : (pausedCursor ? 'Resume' : (requiresFullBackup ? 'Full Backup' : 'Backup Changes'));
    const backupClass = activeProgress
      ? 'btn-outline-warning'
      : (requiresFullBackup ? 'btn-outline-warning' : 'btn-outline-primary');
    const backupDisabled = targetUnavailable || Boolean(activeProgress);
    const targetRootLabel = source.targetSubdir;
    const sourceSizeLabel = source.sourceSizeBytes === null || source.sourceSizeBytes === undefined
      ? '-'
      : formatBytes(source.sourceSizeBytes);
    const backupSizeLabel = source.backupSizeBytes === null || source.backupSizeBytes === undefined
      ? '-'
      : formatBytes(source.backupSizeBytes);
    const sourceChangeEntry = state.sourceChanges[changeKey];
    const sourceChangeCount = sourceChangeEntry?.data?.items?.length || 0;
    const sourceChangeLabel = sourceChangeCount > 0 ? `Changes (${sourceChangeCount})` : 'Changes';

    return `
      <tr>
        <td>
          <div class="path-cell">${escapeHtml(source.sourcePath)}</div>
          <div class="small muted mt-1">Source Size: ${escapeHtml(sourceSizeLabel)}</div>
        </td>
        <td>
          <div class="path-cell">${escapeHtml(targetRootLabel)}</div>
          <div class="small muted mt-1">Backed Up: ${escapeHtml(backupSizeLabel)}</div>
        </td>
        <td>
          <span class="scan-badge ${scanBadgeClass(sourceStatus)}">${escapeHtml(sourceStatus)}</span>
        </td>
        <td><div class="small">${escapeHtml(formatTimestamp(source.lastCompletedAt))}</div></td>
        <td>
          <div class="actions-row">
            <button class="btn btn-sm btn-outline-secondary toggle-changes-button${state.sourceChangeExpanded[changeKey] ? ' active' : ''}" data-target-id="${escapeHtml(target.id)}" data-source-id="${escapeHtml(source.sourceId)}">${escapeHtml(sourceChangeLabel)}</button>
            <button class="btn btn-sm ${backupClass} run-backup-button" data-target-root="${escapeHtml(targetRoot)}" data-machine-id="${escapeHtml(source.machineId)}" data-source-id="${escapeHtml(source.sourceId)}"${backupDisabled ? ' disabled' : ''}>${backupLabel}</button>
            <button class="btn btn-sm btn-outline-secondary restore-source-button" data-target-root="${escapeHtml(targetRoot)}" data-machine-id="${escapeHtml(source.machineId)}" data-source-id="${escapeHtml(source.sourceId)}"${restoreDisabled ? ' disabled' : ''}>Restore</button>
            ${showDeleteButtons ? `<button class="btn btn-sm btn-outline-danger delete-source-button" data-target-id="${escapeHtml(target.id)}" data-target-root="${escapeHtml(targetRoot)}" data-machine-id="${escapeHtml(source.machineId)}" data-source-id="${escapeHtml(source.sourceId)}" data-source-path="${escapeHtml(source.sourcePath)}"${deleteDisabled ? ' disabled' : ''}>Delete</button>` : ''}
          </div>
        </td>
      </tr>
      ${renderSourceChangePanel(target, source)}
      ${renderProgressPanel(targetRoot, source)}
    `;
  }).join('');

  return `
    ${targetUnavailable ? `
      <div class="target-unavailable-banner">
        Target volume is not mounted. Backup actions are unavailable until the drive is reconnected.${target.unavailableReason ? ` <span class="muted">${escapeHtml(target.unavailableReason)}</span>` : ''}
      </div>
    ` : ''}
    <table class="source-table">
      <colgroup>
        <col class="source-col-source">
        <col class="source-col-target">
        <col class="source-col-status">
        <col class="source-col-completed">
        <col class="source-col-actions">
      </colgroup>
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

  container.querySelectorAll('.toggle-source-delete-button').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSourceDeleteMode(button.dataset.targetId);
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

  container.querySelectorAll('.toggle-changes-button').forEach((button) => {
    button.addEventListener('click', () => toggleSourceChanges(
      button.dataset.targetId,
      button.dataset.sourceId
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

  container.querySelectorAll('.delete-source-button').forEach((button) => {
    button.addEventListener('click', () => removeSourceFromTarget(
      button.dataset.targetId,
      button.dataset.targetRoot,
      button.dataset.machineId,
      button.dataset.sourceId,
      button.dataset.sourcePath,
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
    const unavailableClass = target.available === false ? 'unavailable' : '';

    return `
      <article class="target-panel ${collapsedClass} ${activeClass} ${unavailableClass}" data-target-id="${escapeHtml(target.id)}">
        <div class="target-panel-header" data-target-id="${escapeHtml(target.id)}">
          <span class="target-chevron" aria-hidden="true">▶</span>
          ${TARGET_HEADER_ICON}
          <div class="target-panel-title">
            <div class="target-panel-label" title="${escapeHtml(target.path)}">${renderTargetHeaderLabel(target.path)}</div>
          </div>
          <div class="target-panel-meta">
            ${isRunning ? '<span class="target-running-dot" title="Backup running"></span>' : ''}
            ${target.available === false ? '<span class="target-status-badge target-status-unavailable">Unavailable</span>' : ''}
            <span class="target-count-badge">${sourceCount} source${sourceCount === 1 ? '' : 's'}</span>
          </div>
          <div class="target-panel-actions">
            <button type="button" class="btn-target-action add-source-button" data-target-root="${escapeHtml(target.path)}">+ Source</button>
            <button type="button" class="btn-target-action danger remove-target-button" data-target-id="${escapeHtml(target.id)}" data-target-root="${escapeHtml(target.path)}" title="Remove from list">Remove</button>
            <button type="button" class="btn-target-action icon-only toggle-source-delete-button${state.sourceDeleteExpanded[target.id] ? ' active' : ''}" data-target-id="${escapeHtml(target.id)}" title="Toggle source delete mode" aria-label="Toggle source delete mode">⚙</button>
          </div>
        </div>
        <div class="target-panel-body">
          <div class="sources-wrap">${renderTargetSourcesTable(target)}</div>
        </div>
      </article>
    `;
  }).join('');

  bindTargetPanelActions(container);
}

function renderSources() {
  renderTargets();
}

function renderDashboard() {
  const logLevelSelect = document.getElementById('logLevelSelect');
  if (logLevelSelect && state.dashboard.logLevel) {
    logLevelSelect.value = state.dashboard.logLevel;
  }
  renderTargets();
  const targets = state.dashboard.targets || [];
  const targetSummary = targets.map((target) => ({
    path: target.path,
    available: target.available,
    unavailableReason: target.unavailableReason || null
  }));
  const firstPanel = document.querySelector('.target-panel');
  appendLog('info', 'Dashboard rendered.', {
    targetSummary,
    firstPanelUnavailableClass: firstPanel ? firstPanel.classList.contains('unavailable') : null
  });
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
  updateTargetFolderPlaceholder();
}

function hideAddSourceModal() {
  const modal = getAddSourceModal();
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
}

function updateTargetFolderPlaceholder() {
  const input = document.getElementById('targetFolderInput');
  if (!input) {
    return;
  }

  const sourcePath = document.getElementById('sourcePathInput')?.value.trim() || '';
  const targetRoot = String(state.addSourceTargetRoot || '').trim();
  const sourceFolderName = sourcePath ? pathBasename(sourcePath) : 'source folder';
  const defaultTargetPath = [targetRoot, sourceFolderName]
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/');

  input.placeholder = defaultTargetPath || '<backup target>/source folder';
}

async function refreshDashboard() {
  const requestStartedAt = Date.now();
  appendLog('info', 'Requesting dashboard snapshot from main process.');
  const dashboard = await window.myBackup.getDashboard();
  appendLog('info', 'Dashboard snapshot received from main process.', {
    targetCount: dashboard?.targets ? dashboard.targets.length : 0,
    unavailableTargets: (dashboard?.targets || []).filter((target) => target.available === false).length
  });
  if (lastDashboardPushAt > requestStartedAt) {
    appendLog('info', 'Skipped stale dashboard snapshot because a newer push update already arrived.', {
      requestStartedAt,
      lastDashboardPushAt
    });
    return;
  }
  state.dashboard = dashboard;
  renderDashboard();
  refreshOpenChangePanels();
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
    await nextUiFrame();
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
    Object.keys(state.sourceChangeExpanded).forEach((key) => {
      if (key.startsWith(`${targetId}::`)) {
        delete state.sourceChangeExpanded[key];
        delete state.sourceChanges[key];
      }
    });
    renderDashboard();
  } catch (error) {
    appendLog('error', error.message || 'Failed to remove backup target.');
  }
}

function toggleSourceDeleteMode(targetId) {
  state.sourceDeleteExpanded[targetId] = !state.sourceDeleteExpanded[targetId];
  renderSources();
}

async function removeSourceFromTarget(targetId, targetRoot, machineId, sourceId, sourcePath, button) {
  const key = progressKey(targetRoot, machineId, sourceId);
  const changeKey = sourceChangeKey(targetId, sourceId);
  if (state.backupProgress[key]) {
    appendLog('warn', 'Cannot delete a source while its backup is running.');
    return;
  }

  const confirmed = window.confirm(
    `Delete source from app list?\n\n${sourcePath}\n\nBackup data on disk is not deleted.`
  );
  if (!confirmed) {
    return;
  }

  try {
    setBusy(button, true, 'Deleting...');
    state.dashboard = await window.myBackup.removeSource({
      targetRoot,
      machineId,
      sourceId
    });
    delete state.sourceChangeExpanded[changeKey];
    delete state.sourceChanges[changeKey];
    if ((state.dashboard.targets || []).every((target) => target.id !== targetId || (target.sources || []).length === 0)) {
      delete state.sourceDeleteExpanded[targetId];
    }
    renderDashboard();
  } catch (error) {
    appendLog('error', error.message || 'Failed to delete source.');
  } finally {
    setBusy(button, false);
  }
}

async function toggleTargetPanel(targetId) {
  const target = (state.dashboard.targets || []).find((entry) => entry.id === targetId);
  const collapsed = target ? !target.collapsed : false;
  if (target) {
    target.collapsed = collapsed;
    renderTargets();
  }
  try {
    await window.myBackup.setTargetCollapsed({
      targetId,
      collapsed
    });
  } catch (error) {
    if (target) {
      target.collapsed = !collapsed;
      renderTargets();
    }
    appendLog('error', error.message || 'Failed to update target panel.');
  }
}

async function loadSourceChanges(targetId, sourceId) {
  const key = sourceChangeKey(targetId, sourceId);
  state.sourceChanges[key] = {
    loading: true,
    error: null,
    data: null
  };
  renderSources();

  try {
    const data = await window.myBackup.getChangeList({ targetId, sourceId });
    state.sourceChanges[key] = {
      loading: false,
      error: null,
      data
    };
  } catch (error) {
    state.sourceChanges[key] = {
      loading: false,
      error: error.message || 'Failed to load changes.',
      data: null
    };
  }

  renderSources();
}

function refreshOpenChangePanels() {
  Object.entries(state.sourceChangeExpanded)
    .filter(([, expanded]) => expanded)
    .forEach(([key]) => {
      const [targetId, sourceId] = key.split('::');
      void loadSourceChanges(targetId, sourceId);
    });
}

function toggleSourceChanges(targetId, sourceId) {
  const key = sourceChangeKey(targetId, sourceId);
  const nextExpanded = !state.sourceChangeExpanded[key];
  state.sourceChangeExpanded[key] = nextExpanded;
  renderSources();

  if (nextExpanded) {
    void loadSourceChanges(targetId, sourceId);
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
      updateTargetFolderPlaceholder();
    }
  } catch (error) {
    appendLog('error', error.message || 'Failed to select source folder.');
  }
}

async function browseTargetFolder() {
  try {
    const selectedPath = await window.myBackup.pickTargetFolder({
      targetRoot: state.addSourceTargetRoot
    });
    if (selectedPath !== null) {
      document.getElementById('targetFolderInput').value = selectedPath;
    }
  } catch (error) {
    appendLog('error', error.message || 'Failed to select target folder.');
  }
}

async function registerSource(event) {
  event.preventDefault();
  const button = document.getElementById('addSourceButton');
  const sourcePath = document.getElementById('sourcePathInput').value.trim();
  const targetFolder = document.getElementById('targetFolderInput').value.trim();

  if (!sourcePath) {
    appendLog('error', 'Source folder is required.');
    return;
  }

  try {
    setBusy(button, true, 'Registering...');
    let response = await window.myBackup.addSource({
      targetRoot: state.addSourceTargetRoot,
      sourcePath,
      targetFolder,
      confirmMerge: false
    });
    if (response && response.conflict) {
      const confirmed = window.confirm(`Target folder already exists:\n${response.targetSourceRoot}\n\nMerge into this folder?`);
      if (!confirmed) {
        return;
      }
      response = await window.myBackup.addSource({
        targetRoot: state.addSourceTargetRoot,
        sourcePath,
        targetFolder,
        confirmMerge: true
      });
    }
    state.dashboard = response.dashboard;
    renderDashboard();
    document.getElementById('sourceForm').reset();
    updateTargetFolderPlaceholder();
    hideAddSourceModal();
  } catch (error) {
    appendLog('error', error.message || 'Failed to register source.');
  } finally {
    setBusy(button, false);
  }
}

async function runBackup(targetRoot, machineId, sourceId, button) {
  const key = progressKey(targetRoot, machineId, sourceId);
  appendLog('info', 'Backup UI action invoked.', {
    key,
    targetRoot,
    machineId,
    sourceId,
    hasExistingProgress: Boolean(state.backupProgress[key])
  });
  const currentTarget = (state.dashboard.targets || []).find((entry) => entry.path === targetRoot);
  if (currentTarget && currentTarget.available === false) {
    appendLog('warn', 'Backup target is unavailable.');
    return;
  }
  if (state.backupProgress[key]) {
    try {
      state.pauseRequests[key] = true;
      renderSources();
      const response = await window.myBackup.pauseBackup({ targetRoot, machineId, sourceId });
      if (!response || response.accepted !== true) {
        clearBackupUiState(key);
        await refreshDashboard();
        renderSources();
      }
    } catch (error) {
      delete state.pauseRequests[key];
      appendLog('error', error.message || 'Failed to pause backup.');
      renderSources();
    }
    return;
  }

  const target = currentTarget;
  const source = (target?.sources || []).find((entry) => entry.machineId === machineId && entry.sourceId === sourceId);
  if (target && target.collapsed) {
    target.collapsed = false;
    renderTargets();
    window.myBackup.setTargetCollapsed({ targetId: target.id, collapsed: false }).catch(() => {});
  }
  try {
    const persistedCopiedBytes = Number(source?.backupStatus?.copiedBytes || 0);
    state.backupProgress[key] = {
      targetRoot,
      machineId,
      sourceId,
      progress: {
        status: 'running',
        filesProcessed: 0,
        filesCopied: 0,
        copiedBytes: persistedCopiedBytes,
        workers: {}
      },
      event: null
    };
    appendLog('info', 'Progress trace: optimistic running row created.', {
      key,
      progressPanelLoaded: Boolean(window.myBackupProgressPanel)
    });
    renderSources();
    const forceNewScan = !source?.baselineAt
      || source?.sourceSizeBytes === null
      || source?.sourceSizeBytes === undefined
      || Boolean(source?.watchState?.needsRescan);
    const result = await window.myBackup.runBackup({
      targetRoot,
      machineId,
      sourceId,
      forceNewScan
    });
    clearBackupUiState(key);
    state.dashboard = result.dashboard;
    renderDashboard();
    appendLog('info', result.summary.status === 'paused' ? 'Backup paused.' : 'Backup summary.', result.summary);
  } catch (error) {
    clearBackupUiState(key);
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

document.addEventListener('DOMContentLoaded', async () => {
  try {
    state.runtimeFlags = {
      ...state.runtimeFlags,
      ...(await window.myBackup.getRuntimeFlags())
    };
    if (state.runtimeFlags.traceProgressUi) {
      appendLog('info', 'Progress UI tracing enabled.');
    }
  } catch (error) {
    appendLog('warn', 'Failed to load runtime flags.', { message: error.message });
  }
  appendLog('info', 'Progress trace hooks registered.', {
    traceProgressUi: state.runtimeFlags.traceProgressUi,
    progressPanelLoaded: Boolean(window.myBackupProgressPanel)
  });

  document.getElementById('addTargetButton').addEventListener('click', addTarget);
  document.getElementById('closeAddSourceButton').addEventListener('click', hideAddSourceModal);
  document.getElementById('cancelAddSourceButton').addEventListener('click', hideAddSourceModal);
  getAddSourceModal()?.addEventListener('click', (event) => {
    if (event.target === getAddSourceModal()) {
      hideAddSourceModal();
    }
  });
  document.getElementById('browseSourceButton').addEventListener('click', browseSource);
  document.getElementById('browseTargetFolderButton').addEventListener('click', browseTargetFolder);
  document.getElementById('sourcePathInput').addEventListener('input', updateTargetFolderPlaceholder);
  document.getElementById('sourceForm').addEventListener('submit', registerSource);
  document.getElementById('logLevelSelect').addEventListener('change', updateLogLevel);
  document.getElementById('copyLogsButton')?.addEventListener('click', copyLogsToClipboard);
  window.myBackup.onBackupProgress((payload) => {
    const key = progressKeyFromPayload(payload);
    if (state.progressPayloadTraceCount < PROGRESS_TRACE_LOG_LIMIT) {
      appendLog('info', 'Progress trace: IPC payload received.', {
        key,
        sequence: payload.trace?.sequence || null,
        eventType: payload.event?.type || null,
        eventPool: payload.event?.pool || null,
        status: payload.progress?.status || null,
        workerCount: Object.keys(payload.progress?.workers || {}).length,
        fileQueueDepth: payload.progress?.queues?.file?.depth || 0
      });
    }
    const status = payload.progress?.status || null;
    const isTerminal = status === 'paused' || status === 'completed';
    if (isTerminal) {
      clearBackupUiState(key);
    } else {
      state.backupProgress[key] = payload;
    }
    traceProgressRender(key, payload);
    if (payload.event?.type === 'backup-pausing' && payload.event?.phase) {
      appendLog('info', `Backup pausing: ${payload.event.phase}.`, payload.progress?.queues || null);
    }

    const shouldRenderImmediately = window.myBackupProgressPanel
      ? window.myBackupProgressPanel.shouldRenderImmediatelyForProgress(payload)
      : payload.event?.type === 'backup-paused'
        || payload.event?.type === 'backup-completed'
        || payload.event?.type === 'backup-started'
        || payload.progress?.status === 'paused';

    if (shouldRenderImmediately) {
      flushProgressRender();
    } else {
      scheduleProgressRender();
    }
  });
  window.myBackup.onDashboardUpdated((dashboard) => {
    lastDashboardPushAt = Date.now();
    appendLog('info', 'Dashboard update received from main process.', {
      targetCount: dashboard?.targets ? dashboard.targets.length : 0,
      unavailableTargets: (dashboard?.targets || []).filter((target) => target.available === false).length
    });
    state.dashboard = dashboard;
    renderDashboard();
    refreshOpenChangePanels();
  });
  window.myBackup.onLog((entry) => appendLog(entry.level, entry.message, entry.details));
  await refreshDashboard();
  renderLogs();
});

if (typeof module !== 'undefined') {
  module.exports = {
    __test__: {
      state,
      renderTargetSourcesTable,
      renderTargets
    }
  };
}
