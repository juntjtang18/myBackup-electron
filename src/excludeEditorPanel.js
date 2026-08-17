(function initExcludeEditorPanel(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.myBackupExcludeEditor = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : window, function createExcludeEditorPanelModule() {
  const IGNORE_PRESETS = [
    { id: 'node_modules', label: 'node_modules', pattern: 'node_modules/' },
    { id: 'vendor', label: 'vendor', pattern: 'vendor/' },
    { id: 'bower', label: 'bower_components', pattern: 'bower_components/' },
    { id: 'venv_dot', label: '.venv', pattern: '.venv/' },
    { id: 'venv', label: 'venv', pattern: 'venv/' },
    { id: 'pycache', label: '__pycache__', pattern: '__pycache__/' },
    { id: 'pytest', label: '.pytest_cache', pattern: '.pytest_cache/' },
    { id: 'mypy', label: '.mypy_cache', pattern: '.mypy_cache/' },
    { id: 'tox', label: '.tox', pattern: '.tox/' },
    { id: 'next', label: '.next', pattern: '.next/' },
    { id: 'nuxt', label: '.nuxt', pattern: '.nuxt/' },
    { id: 'turbo', label: '.turbo', pattern: '.turbo/' },
    { id: 'parcel', label: '.parcel-cache', pattern: '.parcel-cache/' },
    { id: 'dist', label: 'dist', pattern: 'dist/' },
    { id: 'build', label: 'build', pattern: 'build/' },
    { id: 'target', label: 'target', pattern: 'target/' },
    { id: 'coverage', label: 'coverage', pattern: 'coverage/' },
    { id: 'pods', label: 'Pods', pattern: 'Pods/' },
    { id: 'derived', label: 'DerivedData', pattern: 'DerivedData/' },
    { id: 'gradle', label: '.gradle', pattern: '.gradle/' },
    { id: 'idea', label: '.idea', pattern: '.idea/' },
    { id: 'cache', label: '.cache', pattern: '.cache/' },
    { id: 'terraform', label: '.terraform', pattern: '.terraform/' },
    { id: 'obj', label: 'obj', pattern: 'obj/' }
  ];

  const SOURCE_IGNORE_TEMPLATE = [
    '# Temporary files',
    '*.tmp',
    '*.temp',
    '~$*',
    '',
    '# System files',
    '.DS_Store',
    '._*',
    'Thumbs.db',
    'Desktop.ini',
    '',
    '# OS metadata',
    '.Spotlight-V100/',
    '.Trashes/',
    '.fseventsd/',
    '',
    '# VCS metadata',
    '.git/',
    '',
    '# MyBackup metadata',
    '.mybackup/',
    '',
    '# Build and dependency caches',
    ...IGNORE_PRESETS.map((preset) => preset.pattern),
    ''
  ].join('\n');

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function normalizeText(value) {
    return String(value || '').replace(/\r\n/g, '\n');
  }

  function buildLineNumbers(text) {
    const lines = Math.max(1, normalizeText(text).split('\n').length);
    return Array.from({ length: lines }, (_unused, index) => String(index + 1)).join('\n');
  }

  function patternAliases(pattern) {
    const trimmed = String(pattern || '').trim();
    const aliases = new Set([trimmed]);
    if (trimmed.endsWith('/')) {
      aliases.add(trimmed.slice(0, -1));
    } else if (trimmed) {
      aliases.add(`${trimmed}/`);
    }
    return aliases;
  }

  function ignoreTextHasPattern(text, pattern) {
    const aliases = patternAliases(pattern);
    return normalizeText(text).split('\n').some((line) => aliases.has(line.trim()));
  }

  function addIgnorePattern(text, pattern) {
    const normalizedPattern = String(pattern || '').trim();
    if (!normalizedPattern || ignoreTextHasPattern(text, normalizedPattern)) {
      return normalizeText(text);
    }
    const normalized = normalizeText(text).replace(/\s+$/, '');
    return `${normalized}${normalized ? '\n' : ''}${normalizedPattern}\n`;
  }

  function removeIgnorePattern(text, pattern) {
    const aliases = patternAliases(pattern);
    return normalizeText(text)
      .split('\n')
      .filter((line) => !aliases.has(line.trim()))
      .join('\n');
  }

  function toggleIgnorePattern(text, pattern) {
    return ignoreTextHasPattern(text, pattern)
      ? removeIgnorePattern(text, pattern)
      : addIgnorePattern(text, pattern);
  }

  function summarizeText(text) {
    const lines = normalizeText(text).split('\n');
    let comments = 0;
    let patterns = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed.startsWith('#')) {
        comments += 1;
      } else {
        patterns += 1;
      }
    }
    return {
      comments,
      patterns
    };
  }

  function renderExcludePanel(viewModel) {
    const draftText = normalizeText(viewModel?.draftText || '');
    const originalText = normalizeText(viewModel?.originalText || '');
    const defaultTemplate = normalizeText(viewModel?.defaultTemplate || '');
    const isBusy = Boolean(viewModel?.isLoading || viewModel?.isSaving);
    const isDirty = draftText !== originalText;
    const pendingAdd = Boolean(viewModel?.pendingAdd);
    const canSave = pendingAdd || isDirty;
    const sourceLabel = viewModel?.sourceLabel || 'source';
    const errorMessage = viewModel?.errorMessage || '';
    const summary = summarizeText(draftText);
    const lineNumbers = buildLineNumbers(draftText);

    return `
      <section class="exclude-editor-panel${pendingAdd ? ' is-pending-add' : ''}" data-target-id="${escapeHtml(viewModel?.targetId || '')}" data-source-id="${escapeHtml(viewModel?.sourceId || '')}">
        <div class="exclude-editor-toolbar">
          <div class="exclude-editor-heading">
            <span class="exclude-editor-title">EXCLUDE RULES</span>
            <span class="exclude-editor-source">${escapeHtml(sourceLabel)}</span>
          </div>
          <div class="exclude-editor-actions">
            <button type="button" class="exclude-editor-btn exclude-editor-reset"${isBusy ? ' disabled' : ''}>Reset</button>
            <button type="button" class="exclude-editor-btn exclude-editor-cancel"${isBusy ? ' disabled' : ''}>Cancel</button>
            <button type="button" class="exclude-editor-btn exclude-editor-save"${isBusy || !canSave ? ' disabled' : ''}>${viewModel?.isSaving ? 'Saving...' : 'Save'}</button>
          </div>
        </div>
        ${pendingAdd ? '<div class="exclude-editor-pending">Save these rules to add the source. Cancel discards the add.</div>' : ''}
        <div class="exclude-editor-presets" role="group" aria-label="Excluded folders. Click to keep one in the backup.">
          ${IGNORE_PRESETS.map((preset) => {
            const pressed = ignoreTextHasPattern(draftText, preset.pattern);
            return `<button type="button" class="exclude-editor-preset${pressed ? ' is-pressed' : ''}" data-pattern="${escapeHtml(preset.pattern)}" aria-pressed="${pressed ? 'true' : 'false'}"${isBusy ? ' disabled' : ''}>${escapeHtml(preset.label)}</button>`;
          }).join('')}
        </div>
        <div class="exclude-editor-help">Selected capsules are excluded. Click one to keep that folder in the backup. One pattern per line · <code>folder/</code> · <code>*.ext</code> · <code>#</code> comments</div>
        ${errorMessage ? `<div class="exclude-editor-error">${escapeHtml(errorMessage)}</div>` : ''}
        <div class="exclude-editor-body">
          <pre class="exclude-editor-lines" aria-hidden="true">${escapeHtml(lineNumbers)}</pre>
          <textarea
            class="exclude-editor-textarea"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            data-original-text="${escapeHtml(originalText)}"
            data-default-template="${escapeHtml(defaultTemplate)}"
            ${isBusy ? 'disabled' : ''}
          >${escapeHtml(draftText)}</textarea>
        </div>
        <div class="exclude-editor-footer">
          <span class="exclude-editor-pattern-count">${summary.patterns} active pattern${summary.patterns === 1 ? '' : 's'}</span>
          <span class="exclude-editor-comment-count">${summary.comments} comment${summary.comments === 1 ? '' : 's'}</span>
        </div>
      </section>
    `;
  }

  function refreshPanelMetrics(panelElement, text) {
    if (!panelElement) {
      return;
    }
    const normalized = normalizeText(text);
    const summary = summarizeText(normalized);
    const lineNumbers = buildLineNumbers(normalized);
    const linesElement = panelElement.querySelector('.exclude-editor-lines');
    const patternCountElement = panelElement.querySelector('.exclude-editor-pattern-count');
    const commentCountElement = panelElement.querySelector('.exclude-editor-comment-count');
    if (linesElement) {
      linesElement.textContent = lineNumbers;
    }
    if (patternCountElement) {
      patternCountElement.textContent = `${summary.patterns} active pattern${summary.patterns === 1 ? '' : 's'}`;
    }
    if (commentCountElement) {
      commentCountElement.textContent = `${summary.comments} comment${summary.comments === 1 ? '' : 's'}`;
    }
    panelElement.querySelectorAll('.exclude-editor-preset').forEach((button) => {
      const pressed = ignoreTextHasPattern(normalized, button.dataset.pattern);
      button.classList.toggle('is-pressed', pressed);
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
  }

  return {
    SOURCE_IGNORE_TEMPLATE,
    IGNORE_PRESETS,
    addIgnorePattern,
    ignoreTextHasPattern,
    normalizeText,
    removeIgnorePattern,
    renderExcludePanel,
    refreshPanelMetrics,
    toggleIgnorePattern
  };
}));
