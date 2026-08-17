const {
  IGNORE_PRESETS,
  SOURCE_IGNORE_TEMPLATE,
  addIgnorePattern,
  ignoreTextHasPattern,
  renderExcludePanel,
  refreshPanelMetrics,
  toggleIgnorePattern
} = require('../src/excludeEditorPanel');

describe('exclude editor presets', () => {
  test('includes popular library folders', () => {
    const patterns = IGNORE_PRESETS.map((preset) => preset.pattern);
    expect(patterns).toEqual(expect.arrayContaining([
      'node_modules/',
      'vendor/',
      '.venv/',
      'venv/',
      '__pycache__/',
      '.pytest_cache/',
      '.next/',
      '.nuxt/',
      'dist/',
      'build/',
      'target/',
      'coverage/',
      'Pods/',
      'DerivedData/',
      '.gradle/',
      '.idea/',
      '.terraform/',
      'obj/'
    ]));
  });

  test('default template includes every capsule so they start selected', () => {
    IGNORE_PRESETS.forEach((preset) => {
      expect(SOURCE_IGNORE_TEMPLATE).toContain(preset.pattern);
    });

    const html = renderExcludePanel({
      targetId: 'target-a',
      sourceId: '__pending-add__',
      sourceLabel: 'Documents',
      draftText: SOURCE_IGNORE_TEMPLATE,
      originalText: SOURCE_IGNORE_TEMPLATE,
      defaultTemplate: SOURCE_IGNORE_TEMPLATE,
      pendingAdd: true
    });

    IGNORE_PRESETS.forEach((preset) => {
      expect(html).toMatch(new RegExp(`class="exclude-editor-preset is-pressed"[^>]*data-pattern="${preset.pattern.replace('/', '\\/')}"`));
    });
  });

  test('clicking a selected capsule removes that pattern', () => {
    const removed = toggleIgnorePattern(SOURCE_IGNORE_TEMPLATE, 'node_modules/');
    expect(ignoreTextHasPattern(SOURCE_IGNORE_TEMPLATE, 'node_modules/')).toBe(true);
    expect(ignoreTextHasPattern(removed, 'node_modules/')).toBe(false);
    expect(ignoreTextHasPattern(removed, 'vendor/')).toBe(true);
  });

  test('toggle adds a capsule pattern and treats folder aliases as active', () => {
    const added = addIgnorePattern('# Temporary files\n*.tmp\n', 'node_modules/');
    expect(added).toContain('node_modules/');
    expect(ignoreTextHasPattern(added, 'node_modules/')).toBe(true);
    expect(ignoreTextHasPattern('node_modules\n', 'node_modules/')).toBe(true);

    const removed = toggleIgnorePattern(added, 'node_modules/');
    expect(ignoreTextHasPattern(removed, 'node_modules/')).toBe(false);
  });

  test('pending add keeps Save enabled when rules match the template', () => {
    const html = renderExcludePanel({
      targetId: 'target-a',
      sourceId: '__pending-add__',
      sourceLabel: 'Documents',
      draftText: '*.tmp\n',
      originalText: '*.tmp\n',
      defaultTemplate: '*.tmp\n',
      pendingAdd: true
    });

    expect(html).toContain('exclude-editor-pending');
    expect(html).toContain('Save these rules to add the source');
    expect(html).toMatch(/class="exclude-editor-btn exclude-editor-save">Save</);
  });

  test('render marks matching capsules as pressed', () => {
    const html = renderExcludePanel({
      targetId: 'target-a',
      sourceId: 'source-a',
      sourceLabel: 'gpa',
      draftText: 'node_modules/\n.venv/\n',
      originalText: '',
      defaultTemplate: ''
    });

    expect(html).toContain('exclude-editor-presets');
    expect(html).toMatch(/class="exclude-editor-preset is-pressed"[^>]*data-pattern="node_modules\/"/);
    expect(html).toMatch(/class="exclude-editor-preset"[^>]*data-pattern="vendor\/"/);
    expect(html).not.toMatch(/class="exclude-editor-preset is-pressed"[^>]*data-pattern="vendor\/"/);
  });

  test('refreshPanelMetrics updates pressed state after the text changes', () => {
    const buttons = [
      { dataset: { pattern: 'node_modules/' }, classList: { toggle: jest.fn() }, setAttribute: jest.fn() },
      { dataset: { pattern: 'vendor/' }, classList: { toggle: jest.fn() }, setAttribute: jest.fn() }
    ];
    const panel = {
      querySelector: () => null,
      querySelectorAll: () => buttons
    };

    refreshPanelMetrics(panel, 'vendor/\n');
    expect(buttons[0].classList.toggle).toHaveBeenCalledWith('is-pressed', false);
    expect(buttons[1].classList.toggle).toHaveBeenCalledWith('is-pressed', true);
  });
});
