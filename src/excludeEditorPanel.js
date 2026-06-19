(function initExcludeEditorPanel(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.myBackupExcludeEditor = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : window, function createExcludeEditorPanelModule() {
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
    const sourceLabel = viewModel?.sourceLabel || 'source';
    const errorMessage = viewModel?.errorMessage || '';
    const summary = summarizeText(draftText);
    const lineNumbers = buildLineNumbers(draftText);

    return `
      <section class="exclude-editor-panel" data-target-id="${escapeHtml(viewModel?.targetId || '')}" data-source-id="${escapeHtml(viewModel?.sourceId || '')}">
        <div class="exclude-editor-toolbar">
          <div class="exclude-editor-heading">
            <span class="exclude-editor-title">EXCLUDE RULES</span>
            <span class="exclude-editor-source">${escapeHtml(sourceLabel)}</span>
          </div>
          <div class="exclude-editor-actions">
            <button type="button" class="exclude-editor-btn exclude-editor-reset"${isBusy ? ' disabled' : ''}>Reset</button>
            <button type="button" class="exclude-editor-btn exclude-editor-cancel"${isBusy ? ' disabled' : ''}>Cancel</button>
            <button type="button" class="exclude-editor-btn exclude-editor-save"${isBusy || !isDirty ? ' disabled' : ''}>${viewModel?.isSaving ? 'Saving...' : 'Save'}</button>
          </div>
        </div>
        <div class="exclude-editor-help">One pattern per line · <code>folder/</code> excludes directories · <code>*.ext</code> excludes by extension · <code>#</code> for comments</div>
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
  }

  return {
    normalizeText,
    renderExcludePanel,
    refreshPanelMetrics
  };
}));
