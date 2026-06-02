const state = {
  dashboard: {
    targetRoot: null,
    machine: null,
    sources: []
  },
  logs: [],
  backupProgress: {},
  pauseRequests: {}
};

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
    logList.innerHTML = '<li class="empty-state">No activity yet.</li>';
    return;
  }

  logList.innerHTML = state.logs.map((entry) => `
    <li class="log-item">
      <div class="log-meta">
        <span>${entry.level.toUpperCase()}</span>
        <span>${formatTimestamp(entry.timestamp)}</span>
      </div>
      <div>${entry.message}</div>
      ${entry.details ? `<div class="small muted mt-1">${escapeHtml(JSON.stringify(entry.details))}</div>` : ''}
    </li>
  `).join('');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderSources() {
  const container = document.getElementById('sourcesContainer');
  if (!container) {
    return;
  }

  const sources = state.dashboard.sources || [];
  if (sources.length === 0) {
    container.innerHTML = '<div class="empty-state">No sources registered for the current machine.</div>';
    return;
  }

  function renderProgressPanel(source) {
    const key = `${source.machineId}:${source.sourceId}`;
    const entry = state.backupProgress[key];
    if (!entry || !entry.progress) {
      return '';
    }

    const workers = Object.values(entry.progress.workers || {})
      .sort((left, right) => {
        const leftIdle = left.state === 'idle' ? 1 : 0;
        const rightIdle = right.state === 'idle' ? 1 : 0;
        if (leftIdle !== rightIdle) {
          return leftIdle - rightIdle;
        }
        if (left.pool !== right.pool) {
          return left.pool.localeCompare(right.pool);
        }
        return left.workerId.localeCompare(right.workerId);
      });
    const throughputBytes = entry.progress.copyThroughputBytesPerSecond
      || entry.progress.hashThroughputBytesPerSecond
      || 0;
    const throughput = Math.round(((throughputBytes / (1024 * 1024)) * 10)) / 10;
    let hashIndex = 0;
    let copyIndex = 0;
    const workerLines = workers.map((worker) => {
      const totalBytes = worker.totalBytes || 0;
      const copiedBytes = worker.copiedBytes || 0;
      const percent = totalBytes > 0 ? Math.min(100, Math.round((copiedBytes / totalBytes) * 100)) : 0;
      const shortType = worker.pool === 'copy'
        ? `C${copyIndex += 1}`
        : `H${hashIndex += 1}`;
      return `
        <div class="worker-line">
          <span class="worker-type" title="${escapeHtml(worker.pool || 'worker')}">${escapeHtml(shortType)}</span>
          <div class="worker-name" title="${escapeHtml(worker.sourceRelativePath || worker.logicalPath || '-') }">${escapeHtml(worker.sourceRelativePath || worker.logicalPath || '-')}</div>
          <div class="worker-progress"><div class="worker-progress-fill" style="width: ${percent}%"></div></div>
          <div class="worker-bytes">${formatBytes(copiedBytes)} / ${formatBytes(totalBytes)}</div>
        </div>
      `;
    }).join('');

    return `
      <tr class="source-progress-row">
        <td colspan="5">
          <div class="source-progress-panel">
            <div class="progress-summary">
              <span><strong>Status</strong> ${escapeHtml(entry.progress.status || 'running')}</span>
              <span><strong>Files</strong> ${entry.progress.filesProcessed || 0}</span>
              <span><strong>Copied</strong> ${entry.progress.filesCopied || 0}</span>
              <span><strong>Speed</strong> ${throughput} MB/s</span>
            </div>
            <div class="worker-list">${workerLines || '<div class="empty-state">Waiting for worker activity.</div>'}</div>
          </div>
        </td>
      </tr>
    `;
  }

    const rows = sources.map((source) => {
    const key = `${source.machineId}:${source.sourceId}`;
    const activeProgress = state.backupProgress[key];
    const pauseRequested = state.pauseRequests[key];
    const backupLabel = activeProgress
      ? (pauseRequested ? 'Pausing...' : 'Pause')
      : (source.scanStatus === 'paused' ? 'Resume' : 'Backup');
    const backupClass = activeProgress ? 'btn-outline-warning' : 'btn-outline-primary';
    const mergedRoot = source.mergeEnabled
      ? source.mergeKey
      : source.targetSubdir;

    return `
      <tr>
        <td>
          <div class="path-cell">${escapeHtml(source.sourcePath)}</div>
          <div class="mt-2">
            ${source.mergeEnabled ? '<span class="tag tag-merge">Merge</span>' : ''}
            ${source.organizeMedia ? '<span class="tag tag-media">Media</span>' : ''}
          </div>
        </td>
        <td>
          <div class="path-cell">${escapeHtml(mergedRoot)}</div>
        </td>
        <td>
          <div>${escapeHtml(source.scanStatus || 'idle')}</div>
          <div class="small muted">${escapeHtml(source.activeGeneration || '-')}</div>
        </td>
        <td>
          <div class="small">${escapeHtml(formatTimestamp(source.lastCompletedAt))}</div>
        </td>
        <td>
          <div class="actions-row">
            <button class="btn btn-sm ${backupClass} run-backup-button" data-machine-id="${escapeHtml(source.machineId)}" data-source-id="${escapeHtml(source.sourceId)}">${backupLabel}</button>
            <button class="btn btn-sm btn-outline-secondary restore-source-button" data-machine-id="${escapeHtml(source.machineId)}" data-source-id="${escapeHtml(source.sourceId)}">Restore</button>
            ${source.mergeEnabled ? `<button class="btn btn-sm btn-outline-success restore-merged-button" data-logical-root="${escapeHtml(source.targetSubdir)}">Restore Merged</button>` : ''}
          </div>
        </td>
      </tr>
      ${renderProgressPanel(source)}
    `;
  }).join('');

  container.innerHTML = `
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

  container.querySelectorAll('.run-backup-button').forEach((button) => {
    button.addEventListener('click', () => runBackup(button.dataset.machineId, button.dataset.sourceId, button));
  });
  container.querySelectorAll('.restore-source-button').forEach((button) => {
    button.addEventListener('click', () => runRestoreSource(button.dataset.machineId, button.dataset.sourceId, button));
  });
  container.querySelectorAll('.restore-merged-button').forEach((button) => {
    button.addEventListener('click', () => runRestoreMerged(button.dataset.logicalRoot, button));
  });
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
  const targetPath = document.getElementById('targetPath');
  const targetHint = document.getElementById('targetHint');
  const machineLabel = document.getElementById('machineLabel');
  const statMachine = document.getElementById('statMachine');
  const statSources = document.getElementById('statSources');
  const statScanned = document.getElementById('statScanned');
  const logLevelSelect = document.getElementById('logLevelSelect');

  targetPath.textContent = state.dashboard.targetRoot || 'No target selected.';
  targetHint.textContent = state.dashboard.targetRoot
    ? '.mybackup metadata will be stored inside the selected target.'
    : 'Choose the backup root before registering sources.';
  machineLabel.textContent = state.dashboard.machine
    ? `${state.dashboard.machine.displayName} · ${state.dashboard.machine.machineId}`
    : 'No target selected';
  statMachine.textContent = state.dashboard.machine ? state.dashboard.machine.machineId : '-';
  statSources.textContent = String((state.dashboard.sources || []).length);

  const completedTimes = (state.dashboard.sources || [])
    .map((entry) => entry.lastCompletedAt)
    .filter(Boolean)
    .sort();
  statScanned.textContent = completedTimes.length > 0
    ? formatTimestamp(completedTimes[completedTimes.length - 1])
    : '-';
  if (logLevelSelect && state.dashboard.logLevel) {
    logLevelSelect.value = state.dashboard.logLevel;
  }

  renderSources();
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

async function selectTarget() {
  const button = document.getElementById('selectTargetButton');
  try {
    setBusy(button, true, 'Selecting...');
    state.dashboard = await window.myBackup.selectTarget();
    renderDashboard();
  } catch (error) {
    appendLog('error', error.message || 'Failed to select backup target.');
  } finally {
    setBusy(button, false);
  }
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
      sourcePath,
      mergeEnabled,
      organizeMedia,
      mergeKey
    });
    renderDashboard();
    document.getElementById('sourceForm').reset();
  } catch (error) {
    appendLog('error', error.message || 'Failed to register source.');
  } finally {
    setBusy(button, false);
  }
}

async function runBackup(machineId, sourceId, button) {
  const key = `${machineId}:${sourceId}`;
  if (state.backupProgress[key]) {
    try {
      state.pauseRequests[key] = true;
      renderSources();
      await window.myBackup.pauseBackup({ machineId, sourceId });
    } catch (error) {
      delete state.pauseRequests[key];
      appendLog('error', error.message || 'Failed to pause backup.');
      renderSources();
    }
    return;
  }

  const source = (state.dashboard.sources || []).find((entry) => entry.machineId === machineId && entry.sourceId === sourceId);
  try {
    state.backupProgress[key] = {
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
      machineId,
      sourceId,
      forceNewScan: source && source.scanStatus !== 'paused'
    });
    delete state.backupProgress[key];
    delete state.pauseRequests[key];
    state.dashboard = result.dashboard;
    renderDashboard();
    appendLog('info', result.summary.status === 'paused' ? 'Backup paused.' : 'Backup summary.', result.summary);
  } catch (error) {
    delete state.backupProgress[key];
    delete state.pauseRequests[key];
    renderSources();
    appendLog('error', error.message || 'Backup failed.');
  }
}

async function runRestoreSource(machineId, sourceId, button) {
  try {
    setBusy(button, true, 'Restoring...');
    const summary = await window.myBackup.restoreSource({ machineId, sourceId });
    if (summary) {
      appendLog('info', 'Source restore summary.', summary);
    }
  } catch (error) {
    appendLog('error', error.message || 'Source restore failed.');
  } finally {
    setBusy(button, false);
  }
}

async function runRestoreMerged(logicalRoot, button) {
  try {
    setBusy(button, true, 'Restoring...');
    const summary = await window.myBackup.restoreMerged({ logicalRoot });
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
  document.getElementById('selectTargetButton').addEventListener('click', selectTarget);
  document.getElementById('browseSourceButton').addEventListener('click', browseSource);
  document.getElementById('sourceForm').addEventListener('submit', registerSource);
  document.getElementById('logLevelSelect').addEventListener('change', updateLogLevel);
  window.myBackup.onBackupProgress((payload) => {
    state.backupProgress[`${payload.machineId}:${payload.sourceId}`] = payload;
    if (payload.progress && payload.progress.status !== 'running') {
      delete state.pauseRequests[`${payload.machineId}:${payload.sourceId}`];
    }
    renderSources();
  });
  window.myBackup.onLog((entry) => appendLog(entry.level, entry.message, entry.details));
  await refreshDashboard();
  renderLogs();
});
