const state = {
  dashboard: {
    logLevel: 'info',
    targets: []
  },
  addSourceTargetRoot: null,
  logs: [],
  backupProgress: {},
  pauseRequests: {},
  progressPanelExpanded: {},
  sourceDeleteExpanded: {},
  sourceChangeExpanded: {},
  sourceChanges: {},
  runtimeFlags: {
    traceProgressUi: true,
    showProgressQueueDetails: false
  },
  lastProgressTraceAt: {},
  lastSizeTraceAt: {},
  progressPayloadTraceCount: 0,
  progressRenderTraceCount: 0,
  logDockCollapsed: false
};

class DaemonStatusController {
  constructor({
    pillElement,
    valueElement,
    panelElement,
    panelWatchingCountElement,
    panelWatchedPathElement,
    panelEventCountElement
  }) {
    this.pillElement = pillElement || null;
    this.valueElement = valueElement || null;
    this.panelElement = panelElement || null;
    this.panelWatchingCountElement = panelWatchingCountElement || null;
    this.panelWatchedPathElement = panelWatchedPathElement || null;
    this.panelEventCountElement = panelEventCountElement || null;
    this.panelOpen = false;
    this.lastStatus = {
      running: false,
      watchedSources: 0,
      updatedAt: null
    };
    this.handleDocumentClick = this.handleDocumentClick.bind(this);
    this.handleDocumentKeyDown = this.handleDocumentKeyDown.bind(this);
    this.handlePillClick = this.handlePillClick.bind(this);
    this.handlePillKeyDown = this.handlePillKeyDown.bind(this);
    this.bindEvents();
  }

  bindEvents() {
    if (!this.pillElement) {
      return;
    }
    this.pillElement.addEventListener('click', this.handlePillClick);
    this.pillElement.addEventListener('keydown', this.handlePillKeyDown);
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('keydown', this.handleDocumentKeyDown);
  }

  handlePillClick(event) {
    event.preventDefault();
    event.stopPropagation();
    this.togglePanel();
  }

  handlePillKeyDown(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.togglePanel();
    }
  }

  handleDocumentClick(event) {
    if (!this.panelOpen) {
      return;
    }
    const target = event.target;
    if (this.pillElement?.contains(target) || this.panelElement?.contains(target)) {
      return;
    }
    this.togglePanel(false);
  }

  handleDocumentKeyDown(event) {
    if (event.key !== 'Escape' || !this.panelOpen) {
      return;
    }
    this.togglePanel(false);
  }

  togglePanel(forceOpen) {
    if (!this.panelElement || !this.pillElement) {
      return;
    }
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !this.panelOpen;
    this.panelOpen = nextOpen;
    this.panelElement.classList.toggle('open', nextOpen);
    this.panelElement.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
    this.pillElement.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    if (nextOpen && window.myBackup?.getDaemonStatus) {
      window.myBackup.getDaemonStatus()
        .then((status) => this.setStatus(status))
        .catch(() => {});
    }
  }

  setStatus(payload) {
    if (!this.pillElement || !this.valueElement) {
      return;
    }

    const running = Boolean(payload?.running);
    const watchedSources = Number(payload?.watchedSources || 0);
    const updatedAt = payload?.updatedAt || null;
    this.lastStatus = { running, watchedSources, updatedAt };
    this.pillElement.classList.toggle('running', running);
    this.pillElement.classList.toggle('stopped', !running);
    this.valueElement.textContent = running ? 'Running' : 'Stopped';
    this.pillElement.setAttribute('title', running
      ? `Watch daemon running${watchedSources > 0 ? ` • ${watchedSources} sources` : ''}`
      : 'Watch daemon stopped');

    if (this.panelWatchingCountElement) {
      this.panelWatchingCountElement.textContent = `${watchedSources} ${watchedSources === 1 ? 'path' : 'paths'}`;
    }
    if (this.panelWatchedPathElement) {
      const watchedPaths = Array.isArray(payload?.watchedPaths)
        ? payload.watchedPaths.filter((value) => typeof value === 'string' && value.trim() !== '')
        : [];
      const watchedPathLabel = watchedPaths.length === 0
        ? 'n/a'
        : watchedPaths.length === 1
          ? watchedPaths[0]
          : `${watchedPaths[0]} +${watchedPaths.length - 1}`;
      this.panelWatchedPathElement.textContent = watchedPathLabel;
      this.panelWatchedPathElement.title = watchedPaths.join('\n');
    }
    if (this.panelEventCountElement) {
      const eventCount = Number(payload?.eventCount);
      this.panelEventCountElement.textContent = Number.isFinite(eventCount)
        ? `${eventCount}`
        : `${watchedSources}`;
    }
  }
}

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

function collapseSourceChanges(targetId, sourceId) {
  if (!targetId || !sourceId) {
    return false;
  }
  const key = sourceChangeKey(targetId, sourceId);
  if (!state.sourceChangeExpanded[key]) {
    return false;
  }
  delete state.sourceChangeExpanded[key];
  return true;
}

function clearBackupUiState(key) {
  delete state.backupProgress[key];
  delete state.pauseRequests[key];
  delete state.progressPanelExpanded[key];
  delete state.lastProgressTraceAt[key];
}

function progressKeyFromPayload(payload) {
  return progressKey(payload.targetRoot, payload.machineId, payload.sourceId);
}

function findDashboardSource(targetRoot, machineId, sourceId) {
  const target = (state.dashboard.targets || []).find((entry) => entry.path === targetRoot);
  const source = (target?.sources || []).find((entry) => (
    entry.machineId === machineId
    && entry.sourceId === sourceId
  ));
  return { target, source };
}

function traceCopiedBytes(key, message, details = {}, options = {}) {
  if (!state.runtimeFlags.traceProgressUi && !options.force) {
    return;
  }
  const traceKey = `${key}:${message}`;
  const current = JSON.stringify(details);
  if (!options.force && state.lastSizeTraceAt[traceKey] === current) {
    return;
  }
  state.lastSizeTraceAt[traceKey] = current;
  appendLog('info', message, {
    key,
    ...details
  });
}

function applyTerminalProgressToDashboardSource(payload) {
  const status = payload?.progress?.status || null;
  if (status !== 'paused' && status !== 'completed') {
    return;
  }

  const target = (state.dashboard.targets || []).find((entry) => entry.path === payload.targetRoot);
  const source = (target?.sources || []).find((entry) => (
    entry.machineId === payload.machineId
    && entry.sourceId === payload.sourceId
  ));
  if (!source) {
    return;
  }

  const copiedBytes = Number(
    payload.progress?.copiedBytes
    ?? payload.summary?.copiedBytes
    ?? source.backupStatus?.copiedBytes
    ?? 0
  );
  source.backupStatus = {
    ...(source.backupStatus || {}),
    status,
    mode: payload.progress?.mode || source.backupStatus?.mode || null,
    runId: payload.progress?.scanId || payload.summary?.scanId || source.backupStatus?.runId || null,
    copiedBytes: Number.isFinite(copiedBytes) ? copiedBytes : 0,
    completedAt: status === 'completed'
      ? (payload.summary?.completedAt || source.backupStatus?.completedAt || null)
      : null
  };
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

const SOURCE_CARD_TARGET_ICON = `
  <span class="source-card-side-icon source-card-target-icon" title="Target" aria-label="Target">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 4h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"></path>
      <circle cx="12" cy="11" r="2.25"></circle>
      <path d="M6 17.5h12"></path>
    </svg>
  </span>
`;

function sourceCardSideIcon(label = 'Source') {
  const safeLabel = escapeHtml(label);
  return `
  <span class="source-card-side-icon source-card-source-icon" title="${safeLabel}" aria-label="${safeLabel}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2.5" y="4.5" width="19" height="12.5" rx="2"></rect>
      <path d="M2 19.5h20"></path>
      <path d="M12 19.5V22"></path>
      <circle cx="12" cy="10.75" r="1.75"></circle>
    </svg>
  </span>`;
}

const BUTTON_ICON_PLUS = `
  <span class="btn-icon" aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
      <path d="M8 3.25v9.5"></path>
      <path d="M3.25 8h9.5"></path>
    </svg>
  </span>
`;

const BUTTON_ICON_TRASH = `
  <span class="btn-icon" aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3.5 4.5h9"></path>
      <path d="M6.25 2.75h3.5"></path>
      <path d="M5 4.5v7.25c0 .55.45 1 1 1h4c.55 0 1-.45 1-1V4.5"></path>
      <path d="M6.75 6.5v4"></path>
      <path d="M9.25 6.5v4"></path>
    </svg>
  </span>
`;

const BUTTON_ICON_GEAR = `
  <span class="btn-icon" aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 2.75l1 .4.95-.3.85 1.45-.65.75.1 1 .8.55-.3 1.65-1 .15-.7.7.15 1-.95.8-.9-.45-.95.25-.5.95H7l-.5-.95-.95-.25-.9.45-.95-.8.15-1-.7-.7-1-.15-.3-1.65.8-.55.1-1-.65-.75.85-1.45.95.3z"></path>
      <circle cx="8" cy="8" r="1.9"></circle>
    </svg>
  </span>
`;

const BUTTON_ICON_CHANGES = `
  <span class="btn-icon" aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="5" cy="4" r="1.55"></circle>
      <circle cx="11" cy="12" r="1.55"></circle>
      <path d="M6.55 4H9.5c.85 0 1.5.65 1.5 1.5v4.95"></path>
      <path d="M9.25 8.7 11 10.45l1.75-1.75"></path>
      <path d="M9.45 12H6.5c-.85 0-1.5-.65-1.5-1.5V5.55"></path>
      <path d="M6.75 7.3 5 5.55 3.25 7.3"></path>
    </svg>
  </span>
`;

const BUTTON_ICON_BACKUP = `
  <span class="btn-icon" aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M13 8A5 5 0 1 1 8 3"></path>
      <path d="M10.75 3H13v2.25"></path>
      <path d="M13 3L9.75 6.25"></path>
    </svg>
  </span>
`;

const BUTTON_ICON_PLAY = `
  <span class="btn-icon" aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M5 3.75v8.5a.45.45 0 0 0 .7.38l6.1-4.25a.45.45 0 0 0 0-.76L5.7 3.37a.45.45 0 0 0-.7.38z"></path>
    </svg>
  </span>
`;

const BUTTON_ICON_PAUSE = `
  <span class="btn-icon" aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M5 3.5h2.1v9H5z"></path>
      <path d="M8.9 3.5H11v9H8.9z"></path>
    </svg>
  </span>
`;

const BUTTON_ICON_RESTORE = `
  <span class="btn-icon" aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 5.25H2.75V3"></path>
      <path d="M2.9 5.15A5.25 5.25 0 1 1 3.5 11.5"></path>
    </svg>
  </span>
`;

function withButtonIcon(icon, text) {
  return `${icon}<span class="btn-label">${escapeHtml(text)}</span>`;
}

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
let daemonStatusController = null;

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
                <span>~${escapeHtml(String(item.eventCount || 0))} file change${item.eventCount === 1 ? '' : 's'}</span>
              </div>
            </li>
          `).join('')}
        </ul>
      `;
    }
  }

  return `
    <section class="source-changes-panel">
      <div class="source-changes-header">
        <div class="source-changes-title">Changes since last backup</div>
        <div class="source-changes-meta">${entry?.data?.generatedAt ? escapeHtml(formatTimestamp(entry.data.generatedAt)) : ''}</div>
      </div>
      ${body}
    </section>
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
  if (!button.dataset.labelHtml) {
    button.dataset.labelHtml = button.innerHTML;
  }

  if (busy) {
    if (label) {
      const labelNode = button.querySelector('.btn-label');
      if (labelNode) {
        labelNode.textContent = label;
      } else {
        button.textContent = label;
      }
    }
  } else {
    if (button.dataset.labelHtml) {
      button.innerHTML = button.dataset.labelHtml;
    }
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

function scanBadgeLines(status) {
  const normalized = String(status || '-').trim();
  if (normalized === 'full backup required') {
    return ['full backup', 'required'];
  }
  const words = normalized.split(/\s+/);
  if (words.length >= 2) {
    const mid = Math.ceil(words.length / 2);
    return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
  }
  return [normalized];
}

function renderScanBadge(status) {
  const lines = scanBadgeLines(status);
  const className = scanBadgeClass(status);
  const lineHtml = lines
    .map((line) => `<span class="scan-badge-line">${escapeHtml(line)}</span>`)
    .join('');
  return `<span class="scan-badge ${className}" title="${escapeHtml(status)}">${lineHtml}</span>`;
}

function renderCompletedCell(value) {
  if (!value) {
    return '<div class="completed-at"><span class="completed-at-date">-</span></div>';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return `<div class="completed-at"><span class="completed-at-date">${escapeHtml(String(value))}</span></div>`;
  }

  return `
    <div class="completed-at">
      <span class="completed-at-date">${escapeHtml(date.toLocaleDateString())}</span>
      <span class="completed-at-time">${escapeHtml(date.toLocaleTimeString())}</span>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatAnimationSeconds(value) {
  if (!Number.isFinite(value)) {
    return '0s';
  }
  return `${value.toFixed(3)}s`;
}

function buildSourceArrowPhaseStyle() {
  // Keep arrow animation on a global time clock so motion is independent
  // from backup payload cadence and copied-byte updates.
  const cycleMs = 1750;
  const nowMs = Date.now();
  const phaseSeconds = -((nowMs % cycleMs) / 1000);
  return ` style="--arrow-phase:${formatAnimationSeconds(phaseSeconds)}"`;
}

function renderProgressPanel(targetRoot, source) {
  const key = progressKey(targetRoot, source.machineId, source.sourceId);
  const entry = state.backupProgress[key];
  if (!entry || !entry.progress || !state.progressPanelExpanded[key] || !window.myBackupProgressPanel) {
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

function getBackedUpSizeLabel(source, activeProgress, key = '') {
  const mode = activeProgress?.progress?.mode || null;
  if (mode === 'restore') {
    const copiedBytes = Number(activeProgress?.progress?.copiedBytes || 0);
    const totalBytes = Number(
      activeProgress?.progress?.totalBytes
      ?? source.backupSizeBytes
      ?? 0
    );
    const remainingBytes = Math.max(0, totalBytes - copiedBytes);
    const label = formatBytes(remainingBytes);
    traceCopiedBytes(key, 'Restore copied bytes trace: size circle rendered.', {
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      source: 'restore-remaining',
      copiedBytes,
      totalBytes,
      remainingBytes,
      label
    });
    return label;
  }

  const copiedBytes = activeProgress?.progress?.copiedBytes;
  const forceResumeTrace = source.backupStatus?.status === 'paused' || activeProgress?.progress?.resumed === true;
  if (Number.isFinite(Number(copiedBytes))) {
    const label = formatBytes(Number(copiedBytes));
    traceCopiedBytes(key, 'Resume copied bytes trace: size circle rendered.', {
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      source: 'active-progress',
      activeProgressCopiedBytes: Number(copiedBytes),
      statusCopiedBytes: Number(source.backupStatus?.copiedBytes || 0),
      backupSizeBytes: Number(source.backupSizeBytes || 0),
      label
    }, { force: forceResumeTrace });
    return label;
  }

  const statusCopiedBytes = source.backupStatus?.copiedBytes;
  if (Number.isFinite(Number(statusCopiedBytes)) && Number(statusCopiedBytes) > 0) {
    const label = formatBytes(Number(statusCopiedBytes));
    traceCopiedBytes(key, 'Resume copied bytes trace: size circle rendered.', {
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      source: 'backup-status',
      activeProgressCopiedBytes: null,
      statusCopiedBytes: Number(statusCopiedBytes),
      backupSizeBytes: Number(source.backupSizeBytes || 0),
      label
    }, { force: forceResumeTrace });
    return label;
  }

  const backupSizeBytes = source.backupSizeBytes;
  if (Number.isFinite(Number(backupSizeBytes)) && Number(backupSizeBytes) > 0) {
    const label = formatBytes(Number(backupSizeBytes));
    traceCopiedBytes(key, 'Resume copied bytes trace: size circle rendered.', {
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      source: 'backup-size',
      activeProgressCopiedBytes: null,
      statusCopiedBytes: Number(source.backupStatus?.copiedBytes || 0),
      backupSizeBytes: Number(backupSizeBytes),
      label
    }, { force: forceResumeTrace });
    return label;
  }

  traceCopiedBytes(key, 'Resume copied bytes trace: size circle rendered.', {
    sourceId: source.sourceId,
    sourcePath: source.sourcePath,
    source: 'zero',
    activeProgressCopiedBytes: null,
    statusCopiedBytes: Number(source.backupStatus?.copiedBytes || 0),
    backupSizeBytes: Number(source.backupSizeBytes || 0),
    label: '0 B'
  }, { force: forceResumeTrace });
  return '0 B';
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
    const activeMode = activeProgress?.progress?.mode || 'backup';
    const restoreInProgress = activeMode === 'restore';
    const pauseRequested = state.pauseRequests[key];
    const isPausing = activeProgress?.progress?.status === 'pausing';
    const pausedCursor = source.backupStatus?.status === 'paused';
    const missingSourceSize = source.sourceSizeBytes === null || source.sourceSizeBytes === undefined;
    const requiresFullBackup = !source.baselineAt
      || missingSourceSize
      || Boolean(source.watchState?.needsRescan);
    const restoreDisabled = targetUnavailable || Boolean(activeProgress);
    const deleteDisabled = Boolean(activeProgress);
    const idleBackupLabel = pausedCursor ? 'Resume' : (requiresFullBackup ? 'Full Backup' : 'Backup Changes');
    const backupLabel = activeProgress && !restoreInProgress
      ? (pauseRequested || isPausing ? 'Pausing...' : 'Pause')
      : idleBackupLabel;
    const backupClass = activeProgress
      ? 'btn-outline-warning'
      : (requiresFullBackup ? 'btn-outline-warning' : 'btn-outline-primary');
    const backupDisabled = targetUnavailable || Boolean(pauseRequested) || isPausing || restoreInProgress;
    const isCopying = Boolean(activeProgress) && !pauseRequested && !isPausing;
    const targetRootLabel = source.targetSubdir;
    const sourceSideLabel = restoreInProgress ? 'Destination' : 'Source';
    const sourceSidePath = restoreInProgress
      ? (activeProgress?.progress?.destinationRoot || source.sourcePath)
      : source.sourcePath;
    const restoreLabel = restoreInProgress ? 'Restoring...' : 'Restore';
    const backedUpSizeLabel = getBackedUpSizeLabel(source, activeProgress, key);
    const sourceChangeEntry = state.sourceChanges[changeKey];
    const sourceChangeCount = sourceChangeEntry?.data?.items?.length || 0;
    const sourceChangeLabel = sourceChangeCount > 0 ? `Changes (${sourceChangeCount})` : 'Changes';
    const arrowPhaseStyle = isCopying ? buildSourceArrowPhaseStyle() : '';

    return `
      <div class="source-card-stack">
        <article class="source-card${isCopying ? ' is-copying' : ''}" data-source-id="${escapeHtml(source.sourceId)}">
          <div class="source-card-top">
            <section class="source-card-side source-card-target">
              <div class="source-card-path-row">
                ${SOURCE_CARD_TARGET_ICON}
                <div class="source-card-path" title="${escapeHtml(targetRootLabel)}">${escapeHtml(targetRootLabel)}</div>
              </div>
            </section>
            <section class="source-card-center">
              <div class="source-card-transfer">
                <div class="source-card-arrow${isCopying ? ' is-copying' : ''}${restoreInProgress ? ' is-restore' : ''}" aria-hidden="true"${arrowPhaseStyle}>
                  <span class="source-card-arrow-shaft"></span>
                  <span class="source-card-arrow-head"></span>
                  <span class="source-card-arrow-dot source-card-arrow-dot-1"></span>
                  <span class="source-card-arrow-dot source-card-arrow-dot-2"></span>
                  <span class="source-card-arrow-dot source-card-arrow-dot-3"></span>
                </div>
                <button type="button" class="source-progress-node${isCopying ? ' is-live' : ''}" data-target-root="${escapeHtml(targetRoot)}" data-machine-id="${escapeHtml(source.machineId)}" data-source-id="${escapeHtml(source.sourceId)}" title="Open backup progress">
                  <span class="source-progress-node-size">${escapeHtml(backedUpSizeLabel)}</span>
                </button>
              </div>
            </section>
            <section class="source-card-side source-card-source">
              <div class="source-card-path-row">
                <div class="source-card-path" title="${escapeHtml(sourceSidePath)}">${escapeHtml(sourceSidePath)}</div>
                ${sourceCardSideIcon(sourceSideLabel)}
              </div>
            </section>
          </div>
          <!--<div class="source-card-divider" aria-hidden="true"></div>-->
          <div class="source-card-bottom">
            <div class="source-card-meta">
              <div class="source-card-backup-line">
                <span class="source-card-clock" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="8" cy="8" r="5.5"></circle>
                    <path d="M8 4.8V8l2.2 1.6"></path>
                  </svg>
                </span>
                <span class="source-card-backup-text">Last backup ${escapeHtml(formatTimestamp(source.lastCompletedAt))}</span>
              </div>
            </div>
            <div class="actions-row">
              <button class="btn btn-sm btn-outline-secondary btn-action btn-action-changes toggle-changes-button${state.sourceChangeExpanded[changeKey] ? ' active' : ''}" data-target-id="${escapeHtml(target.id)}" data-source-id="${escapeHtml(source.sourceId)}" title="${escapeHtml(sourceChangeLabel)}">${withButtonIcon(BUTTON_ICON_CHANGES, sourceChangeLabel)}</button>
              <button class="btn btn-sm ${backupClass} btn-action btn-action-backup run-backup-button" data-target-root="${escapeHtml(targetRoot)}" data-machine-id="${escapeHtml(source.machineId)}" data-source-id="${escapeHtml(source.sourceId)}" title="${escapeHtml(backupLabel)}"${backupDisabled ? ' disabled' : ''}>${withButtonIcon(activeProgress && !restoreInProgress ? BUTTON_ICON_PAUSE : pausedCursor ? BUTTON_ICON_PLAY : BUTTON_ICON_BACKUP, backupLabel)}</button>
              <button class="btn btn-sm btn-outline-secondary btn-action btn-action-restore restore-source-button" data-target-root="${escapeHtml(targetRoot)}" data-machine-id="${escapeHtml(source.machineId)}" data-source-id="${escapeHtml(source.sourceId)}"${restoreDisabled ? ' disabled' : ''}>${withButtonIcon(BUTTON_ICON_RESTORE, restoreLabel)}</button>
              ${showDeleteButtons ? `<button class="btn btn-sm btn-outline-danger btn-action btn-action-delete delete-source-button" data-target-id="${escapeHtml(target.id)}" data-target-root="${escapeHtml(targetRoot)}" data-machine-id="${escapeHtml(source.machineId)}" data-source-id="${escapeHtml(source.sourceId)}" data-source-path="${escapeHtml(source.sourcePath)}"${deleteDisabled ? ' disabled' : ''}>${withButtonIcon(BUTTON_ICON_TRASH, 'Delete')}</button>` : ''}
            </div>
          </div>
        </article>
        ${renderSourceChangePanel(target, source)}
        ${renderProgressPanel(targetRoot, source)}
      </div>
    `;
  }).join('');

  return `
    ${targetUnavailable ? `
      <div class="target-unavailable-banner">
        Target volume is not mounted. Backup and restore actions are unavailable until the drive is reconnected.${target.unavailableReason ? ` <span class="muted">${escapeHtml(target.unavailableReason)}</span>` : ''}
      </div>
    ` : ''}
    <div class="source-card-list">${rows}</div>
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

  container.querySelectorAll('.source-progress-node').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSourceProgressPanel(
        button.dataset.targetRoot,
        button.dataset.machineId,
        button.dataset.sourceId
      );
    });
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
            <button type="button" class="btn-target-action add-source-button" data-target-root="${escapeHtml(target.path)}">${withButtonIcon(BUTTON_ICON_PLUS, 'Source')}</button>
            <button type="button" class="btn-target-action danger remove-target-button" data-target-id="${escapeHtml(target.id)}" data-target-root="${escapeHtml(target.path)}" title="Remove from list">${withButtonIcon(BUTTON_ICON_TRASH, 'Remove')}</button>
            <button type="button" class="btn-target-action settings toggle-source-delete-button${state.sourceDeleteExpanded[target.id] ? ' active' : ''}" data-target-id="${escapeHtml(target.id)}" title="Toggle source delete mode" aria-label="Toggle source delete mode">${withButtonIcon(BUTTON_ICON_GEAR, 'Settings')}</button>
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

function toggleSourceProgressPanel(targetRoot, machineId, sourceId) {
  const key = progressKey(targetRoot, machineId, sourceId);
  if (!state.backupProgress[key]) {
    appendLog('info', 'No active backup progress to show for this source.');
    return;
  }
  state.progressPanelExpanded[key] = !state.progressPanelExpanded[key];
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

function handleBackupProgressPayload(payload) {
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
  const mode = payload.progress?.mode || null;
  const isTerminal = status === 'paused' || status === 'completed' || status === 'failed';
  if (payload.event?.type === 'backup-started'
    || payload.event?.type === 'file-progress'
    || payload.event?.type === 'copy-progress'
    || payload.event?.type === 'backup-paused'
    || payload.event?.type === 'backup-completed') {
    traceCopiedBytes(key, 'Resume copied bytes trace: progress payload accumulated.', {
      eventType: payload.event?.type || null,
      status,
      resumed: payload.progress?.resumed === true,
      progressCopiedBytes: Number(payload.progress?.copiedBytes || 0),
      summaryCopiedBytes: Number(payload.summary?.copiedBytes || 0)
    });
  }
  if (isTerminal) {
    if (mode !== 'restore') {
      applyTerminalProgressToDashboardSource(payload);
      const { source } = findDashboardSource(payload.targetRoot, payload.machineId, payload.sourceId);
      traceCopiedBytes(key, 'Resume copied bytes trace: terminal status applied to dashboard.', {
        status: source?.backupStatus?.status || null,
        runId: source?.backupStatus?.runId || null,
        copiedBytes: Number(source?.backupStatus?.copiedBytes || 0)
      }, { force: true });
    }
    clearBackupUiState(key);
  } else {
    state.backupProgress[key] = payload;
  }
  traceProgressRender(key, payload);
  if (payload.event?.type === 'backup-pausing' && payload.event?.phase) {
    appendLog('info', `Backup pausing: ${payload.event.phase}.`, payload.progress?.queues || null);
  }
  if (payload.event?.type === 'restore-failed') {
    appendLog('error', 'Restore failed.', {
      key,
      message: payload.event?.message || payload.summary?.error || 'Unknown error'
    });
  }

  const shouldRenderImmediately = window.myBackupProgressPanel
    ? window.myBackupProgressPanel.shouldRenderImmediatelyForProgress(payload)
    : payload.event?.type === 'backup-paused'
      || payload.event?.type === 'backup-completed'
      || payload.event?.type === 'backup-started'
      || payload.event?.type === 'restore-started'
      || payload.event?.type === 'restore-completed'
      || payload.event?.type === 'restore-failed'
      || payload.progress?.status === 'paused'
      || payload.progress?.status === 'failed';

  if (shouldRenderImmediately) {
    flushProgressRender();
  } else {
    scheduleProgressRender();
  }
}

async function runBackup(targetRoot, machineId, sourceId, button) {
  const key = progressKey(targetRoot, machineId, sourceId);
  const activeMode = state.backupProgress[key]?.progress?.mode || null;
  if (activeMode === 'restore') {
    appendLog('warn', 'Restore is running for this source. Wait until it completes before starting backup.');
    return;
  }
  appendLog('info', 'Backup UI action invoked.', {
    key,
    targetRoot,
    machineId,
    sourceId,
    hasExistingProgress: Boolean(state.backupProgress[key])
  });

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

  try {
    const { target, source } = findDashboardSource(targetRoot, machineId, sourceId);
    if (target && target.available === false) {
      appendLog('warn', 'Backup target is unavailable.');
      return;
    }
    if (collapseSourceChanges(target?.id, sourceId)) {
      renderSources();
    }
    if (target && target.collapsed) {
      target.collapsed = false;
      renderTargets();
      window.myBackup.setTargetCollapsed({ targetId: target.id, collapsed: false }).catch(() => {});
    }
    state.backupProgress[key] = {
      targetRoot,
      machineId,
      sourceId,
      progress: {
        startedAt: new Date().toISOString(),
        status: 'running',
        filesProcessed: 0,
        filesCopied: 0,
        copiedBytes: 0,
        resumed: false,
        workers: {}
      },
      event: null
    };
    appendLog('info', 'Progress trace: optimistic running row created.', {
      key,
      progressPanelLoaded: Boolean(window.myBackupProgressPanel)
    });
    renderSources();
    const result = await window.myBackup.runBackup({
      targetRoot,
      machineId,
      sourceId,
      forceNewScan: false
    });
    clearBackupUiState(key);
    state.dashboard = result.dashboard;
    renderDashboard();
    if (result?.summary?.status === 'completed') {
      const { target } = findDashboardSource(targetRoot, machineId, sourceId);
      if (target?.id) {
        const changeKey = sourceChangeKey(target.id, sourceId);
        delete state.sourceChanges[changeKey];
        delete state.sourceChangeExpanded[changeKey];
        await loadSourceChanges(target.id, sourceId);
      }
    }
    appendLog('info', result.summary.status === 'paused' ? 'Backup paused.' : 'Backup summary.', result.summary);
  } catch (error) {
    clearBackupUiState(key);
    renderSources();
    appendLog('error', error.message || 'Backup failed.');
  }
}

async function runRestoreSource(targetRoot, machineId, sourceId, button) {
  const key = progressKey(targetRoot, machineId, sourceId);
  const activeMode = state.backupProgress[key]?.progress?.mode || null;
  if (activeMode) {
    appendLog('warn', activeMode === 'restore'
      ? 'Restore is already running for this source.'
      : 'Backup is running for this source. Pause or wait before restoring.');
    return;
  }
  const currentTarget = (state.dashboard.targets || []).find((entry) => entry.path === targetRoot);
  if (currentTarget && currentTarget.available === false) {
    appendLog('warn', 'Backup target is unavailable.');
    return;
  }
  try {
    setBusy(button, true, 'Restoring...');
    const result = await window.myBackup.restoreSource({ targetRoot, machineId, sourceId });
    if (result?.summary) {
      appendLog('info', 'Source restore summary.', result.summary);
      if (result.dashboard) {
        state.dashboard = result.dashboard;
        renderDashboard();
      }
    } else if (result) {
      appendLog('info', 'Source restore summary.', result);
    }
  } catch (error) {
    appendLog('error', error.message || 'Source restore failed.');
  } finally {
    // Keep UI consistent even if terminal restore progress payload is delayed or dropped.
    clearBackupUiState(key);
    renderSources();
    setBusy(button, false);
  }
}

async function syncWindowMaximizedState() {
  if (!window.myBackup?.isWindowMaximized) {
    return;
  }
  const maximized = await window.myBackup.isWindowMaximized();
  document.body.classList.toggle('window-maximized', Boolean(maximized));
}

function setLogDockCollapsed(collapsed) {
  state.logDockCollapsed = Boolean(collapsed);
  document.body.classList.toggle('log-dock-collapsed', state.logDockCollapsed);
  const button = document.getElementById('toggleLogDockButton');
  if (!button) {
    return;
  }
  button.setAttribute('aria-expanded', state.logDockCollapsed ? 'false' : 'true');
  button.setAttribute('aria-label', state.logDockCollapsed ? 'Show activity log' : 'Hide activity log');
  button.setAttribute('title', state.logDockCollapsed ? 'Show activity log' : 'Hide activity log');
}

function initializeLogDockToggle() {
  document.getElementById('toggleLogDockButton')?.addEventListener('click', () => {
    setLogDockCollapsed(!state.logDockCollapsed);
  });
}

function initializeDaemonStatus() {
  daemonStatusController = new DaemonStatusController({
    pillElement: document.getElementById('daemonStatusPill'),
    valueElement: document.getElementById('daemonStatusValue'),
    panelElement: document.getElementById('daemonStatusPanel'),
    panelWatchingCountElement: document.getElementById('daemonPanelWatchingCount'),
    panelWatchedPathElement: document.getElementById('daemonPanelWatchedPath'),
    panelEventCountElement: document.getElementById('daemonPanelEventCount')
  });
  daemonStatusController.setStatus({ running: false });

  if (window.myBackup?.getDaemonStatus) {
    window.myBackup.getDaemonStatus()
      .then((status) => daemonStatusController?.setStatus(status))
      .catch(() => {});
  }

  if (window.myBackup?.onDaemonStatus) {
    window.myBackup.onDaemonStatus((status) => {
      daemonStatusController?.setStatus(status);
    });
  }
}

function initializeWindowChrome() {
  if (!window.myBackup?.getPlatform) {
    return;
  }

  const platform = window.myBackup.getPlatform();
  document.body.classList.add(`platform-${platform}`);

  document.querySelectorAll('[data-window-action]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const action = button.getAttribute('data-window-action');
      if (action === 'minimize') {
        await window.myBackup.minimizeWindow();
        return;
      }
      if (action === 'maximize') {
        await window.myBackup.toggleMaximizeWindow();
        await syncWindowMaximizedState();
        return;
      }
      if (action === 'close') {
        await window.myBackup.closeWindow();
      }
    });
  });

  const titlebar = document.getElementById('appTitlebar');
  titlebar?.addEventListener('dblclick', async (event) => {
    if (event.target.closest('.window-controls, .hero-tools, button, select, label, option')) {
      return;
    }
    await window.myBackup.toggleMaximizeWindow();
    await syncWindowMaximizedState();
  });

  window.myBackup.onWindowMaximizedChanged?.((maximized) => {
    document.body.classList.toggle('window-maximized', Boolean(maximized));
  });

  syncWindowMaximizedState().catch(() => {});
}

async function initializeAppVersionLabel() {
  const versionElement = document.getElementById('heroVersionLabel');
  if (!versionElement || !window.myBackup?.getAppVersion) {
    return;
  }
  try {
    const version = await window.myBackup.getAppVersion();
    if (typeof version === 'string' && version.trim() !== '') {
      versionElement.textContent = `v${version.trim()}`;
    }
  } catch (_error) {
    // Keep default fallback when version retrieval fails.
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await initializeAppVersionLabel();
  initializeWindowChrome();
  initializeLogDockToggle();
  initializeDaemonStatus();
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
  window.myBackup.onBackupProgress(handleBackupProgressPayload);
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
      collapseSourceChanges,
      applyTerminalProgressToDashboardSource,
      handleBackupProgressPayload,
      renderTargetSourcesTable,
      renderTargets,
      toggleSourceProgressPanel,
      runBackup,
      setBusy
    }
  };
}
