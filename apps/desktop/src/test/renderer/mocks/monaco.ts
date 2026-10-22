/**
 * Monaco stub. The real editor needs web workers, layout measurement and canvas, none of which
 * jsdom has. Components under test only need the editor to mount and report its value.
 */

interface Listener {
  dispose: () => void;
}

function listener(): Listener {
  return { dispose: () => undefined };
}

class FakeModel {
  constructor(private value: string) {}
  getValue(): string {
    return this.value;
  }
  setValue(next: string): void {
    this.value = next;
  }
  onDidChangeContent(): Listener {
    return listener();
  }
  dispose(): void {
    return undefined;
  }
  getLineCount(): number {
    return this.value.split('\n').length;
  }
  getLineMaxColumn(line: number): number {
    return (this.value.split('\n')[line - 1] ?? '').length + 1;
  }
  uri = { path: '/test-model' };
}

class FakeEditor {
  private model: FakeModel;
  /** The navigation calls made on this editor, for tests that check where it went. */
  readonly calls: { method: string; args: unknown[] }[] = [];
  private readonly contentListeners = new Set<() => void>();

  constructor(
    readonly container: HTMLElement,
    options: { value?: string } = {},
  ) {
    createdEditors.push(this);
    this.model = new FakeModel(options.value ?? '');
    // Something visible in the DOM makes editor tests assertable.
    const area = document.createElement('textarea');
    area.setAttribute('data-testid', 'monaco-editor');
    area.value = this.model.getValue();
    container.appendChild(area);
  }

  getValue(): string {
    return this.model.getValue();
  }
  /** Like the real editor, a value set from code reports a content change too. */
  setValue(next: string): void {
    this.model.setValue(next);
    for (const fn of this.contentListeners) fn();
  }
  getModel(): FakeModel {
    return this.model;
  }
  setModel(model: FakeModel): void {
    this.model = model;
  }
  onDidChangeModelContent(fn: () => void): Listener {
    this.contentListeners.add(fn);
    return { dispose: () => void this.contentListeners.delete(fn) };
  }
  onDidBlurEditorWidget(): Listener {
    return listener();
  }
  onDidFocusEditorWidget(): Listener {
    return listener();
  }
  updateOptions(): void {
    return undefined;
  }
  layout(): void {
    return undefined;
  }
  focus(): void {
    return undefined;
  }
  dispose(): void {
    return undefined;
  }
  addCommand(): void {
    return undefined;
  }
  addAction(): void {
    return undefined;
  }
  getAction() {
    return { run: async () => undefined };
  }
  revealLine(...args: unknown[]): void {
    this.calls.push({ method: 'revealLine', args });
  }
  revealLineInCenter(...args: unknown[]): void {
    this.calls.push({ method: 'revealLineInCenter', args });
  }
  revealRangeInCenter(...args: unknown[]): void {
    this.calls.push({ method: 'revealRangeInCenter', args });
  }
  revealRangeInCenterIfOutsideViewport(...args: unknown[]): void {
    this.calls.push({ method: 'revealRangeInCenterIfOutsideViewport', args });
  }
  setSelection(...args: unknown[]): void {
    this.calls.push({ method: 'setSelection', args });
  }
  setPosition(...args: unknown[]): void {
    this.calls.push({ method: 'setPosition', args });
  }
  setScrollPosition(...args: unknown[]): void {
    this.calls.push({ method: 'setScrollPosition', args });
  }
  createDecorationsCollection(...args: unknown[]) {
    this.calls.push({ method: 'createDecorationsCollection', args });
    return {
      set: (...setArgs: unknown[]) => this.calls.push({ method: 'decorations.set', args: setArgs }),
      clear: () => undefined,
    };
  }
  getSelection() {
    return null;
  }
  executeEdits(): boolean {
    return true;
  }
  getOriginalEditor(): FakeEditor {
    return this;
  }
  getModifiedEditor(): FakeEditor {
    return this;
  }
}

/** Every editor made since the file started, newest last. */
export const createdEditors: FakeEditor[] = [];

export const editor = {
  create: (container: HTMLElement, options: { value?: string } = {}) =>
    new FakeEditor(container, options),
  createDiffEditor: (container: HTMLElement) => new FakeEditor(container),
  createModel: (value: string) => new FakeModel(value),
  getModel: () => null,
  getModels: () => [] as FakeModel[],
  setModelLanguage: () => undefined,
  /** Every set of markers handed to a model, newest last. */
  markers: [] as unknown[][],
  setModelMarkers(_model: unknown, _owner: string, markers: unknown[]) {
    editor.markers.push(markers);
  },
  defineTheme: () => undefined,
  setTheme: () => undefined,
  EditorOption: {},
};

export const languages = {
  getLanguages: () => [] as { id: string; extensions?: string[]; filenames?: string[] }[],
  register: () => undefined,
  setMonarchTokensProvider: () => undefined,
  setLanguageConfiguration: () => undefined,
  registerCompletionItemProvider: () => listener(),
  typescript: {
    typescriptDefaults: {
      setCompilerOptions: () => undefined,
      setDiagnosticsOptions: () => undefined,
    },
    javascriptDefaults: {
      setCompilerOptions: () => undefined,
      setDiagnosticsOptions: () => undefined,
    },
    ScriptTarget: { ESNext: 99 },
  },
  json: { jsonDefaults: { setDiagnosticsOptions: () => undefined } },
  CompletionItemKind: { Snippet: 27, Text: 18 },
  CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
};

export const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 };
export const KeyCode = { Enter: 3, KeyS: 49, KeyK: 41, Escape: 9 };
export const Uri = {
  parse: (value: string) => ({ path: value, toString: () => value }),
  file: (value: string) => ({ path: value, toString: () => value }),
};
export class Range {
  constructor(
    readonly startLineNumber: number,
    readonly startColumn: number,
    readonly endLineNumber: number,
    readonly endColumn: number,
  ) {}
}
export const MarkerSeverity = { Error: 8, Warning: 4, Info: 2, Hint: 1 };

export default { editor, languages, KeyMod, KeyCode, Uri, Range, MarkerSeverity, createdEditors };
