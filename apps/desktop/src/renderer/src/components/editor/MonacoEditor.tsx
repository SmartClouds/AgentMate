import * as monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { Reveal } from '@/stores/editorRevealStore';
import { resolveMonacoThemeKey } from './monacoSetup';

export function currentMonacoTheme(): string {
  switch (resolveMonacoThemeKey()) {
    case 'light':
      return 'vs';
    case 'dark':
    case 'vscode-dark':
      return 'vs-dark';
    case 'vs2026':
      return 'runova-vs2026';
  }
}

export interface MonacoEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  className?: string;
  /** A place to select and scroll to, such as a search result. Applied once per `nonce`. */
  reveal?: Reveal | null;
  /** Called once the reveal is applied, so the caller can let go of it. */
  onRevealed?: () => void;
  /** Problems to mark inline, one per line, such as what a server refused in a snippet. */
  markers?: ReadonlyArray<{ line: number; message: string }>;
}

/** The owner name the editor's own markers go under, so other markers are left alone. */
const MARKER_OWNER = 'runova';

export function MonacoEditor({
  value,
  onChange,
  language = 'markdown',
  readOnly = false,
  className,
  reveal,
  onRevealed,
  markers,
}: MonacoEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onRevealedRef = useRef(onRevealed);
  onRevealedRef.current = onRevealed;
  const revealedRef = useRef<number | null>(null);
  // Set while the value prop is written in, so the caller doesn't get its own value back as an
  // edit. A file tab took that echo for a draft and kept showing the old file after a switch.
  const applyingRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only setup; prop changes are applied via refs/other effects, not by recreating the editor
  useEffect(() => {
    if (!containerRef.current) return;

    const editor = monaco.editor.create(containerRef.current, {
      value,
      language,
      theme: currentMonacoTheme(),
      // The context menu stays in the page's DOM so index.css can theme it; in a shadow root it can't.
      useShadowDOM: false,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      readOnly,
      wordWrap: 'on',
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;

    const contentDisposable = editor.onDidChangeModelContent(() => {
      if (applyingRef.current) return;
      onChangeRef.current?.(editor.getValue());
    });

    const themeObserver = new MutationObserver(() => {
      monaco.editor.setTheme(currentMonacoTheme());
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      contentDisposable.dispose();
      themeObserver.disconnect();
      editor.dispose();
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) {
      applyingRef.current = true;
      try {
        editor.setValue(value);
      } finally {
        applyingRef.current = false;
      }
    }
  }, [value]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  // Runs after the value effect above, so the lines it points at are already there.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal || revealedRef.current === reveal.nonce) return;
    revealedRef.current = reveal.nonce;
    const range = new monaco.Range(
      reveal.line,
      reveal.column,
      reveal.line,
      reveal.column + (reveal.length ?? 0),
    );
    editor.setSelection(range);
    editor.revealRangeInCenterIfOutsideViewport(range);
    editor.focus();
    onRevealedRef.current?.();
  }, [reveal]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the marks follow the text they point at
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      (markers ?? []).map((marker) => ({
        severity: monaco.MarkerSeverity.Error,
        message: marker.message,
        startLineNumber: marker.line,
        startColumn: 1,
        endLineNumber: marker.line,
        endColumn: model.getLineMaxColumn(Math.min(marker.line, model.getLineCount())),
      })),
    );
  }, [markers, value]);

  // The language is set at creation; this follows later changes, like a request body switched
  // from JSON to XML, without recreating the editor and losing its undo history.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  return (
    <div
      ref={containerRef}
      className={cn(
        'min-h-[240px] w-full overflow-hidden rounded-lg border border-border',
        className,
      )}
    />
  );
}
