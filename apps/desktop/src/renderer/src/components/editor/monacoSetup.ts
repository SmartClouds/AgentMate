import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

/** Monaco themes that sit on the app's own surfaces instead of VS Code's grey. VS Code
 * Dark deliberately has no entry here: its --background token is chosen to match VS
 * Code's real editor.background, so Monaco's stock 'vs-dark' is already seamless. */
monaco.editor.defineTheme('runova-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0b0d0c',
    'editorGutter.background': '#0b0d0c',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorLineNumber.foreground': '#4b524e',
    'editorLineNumber.activeForeground': '#9aa39e',
    'diffEditor.insertedTextBackground': '#00e57222',
    'diffEditor.removedTextBackground': '#f0717826',
    'diffEditor.insertedLineBackground': '#00e57212',
    'diffEditor.removedLineBackground': '#f0717814',
    'diffEditorGutter.insertedLineBackground': '#00e5721c',
    'diffEditorGutter.removedLineBackground': '#f071781f',
    'diffEditor.unchangedRegionBackground': '#121514',
    'diffEditor.border': '#ffffff10',
    'scrollbarSlider.background': '#ffffff12',
    'scrollbarSlider.hoverBackground': '#ffffff22',
    'scrollbarSlider.activeBackground': '#00e57240',
  },
});
monaco.editor.defineTheme('runova-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#fbfbfb',
    'editorGutter.background': '#fbfbfb',
    'diffEditor.insertedTextBackground': '#00994d24',
    'diffEditor.removedTextBackground': '#d9363e24',
    'diffEditor.insertedLineBackground': '#00994d10',
    'diffEditor.removedLineBackground': '#d9363e10',
    'diffEditor.unchangedRegionBackground': '#f0f0f0',
  },
});
monaco.editor.defineTheme('runova-vs2026', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#181921',
    'editorGutter.background': '#181921',
    'editor.lineHighlightBackground': '#ffffff09',
    'editorLineNumber.foreground': '#5b5f73',
    'editorLineNumber.activeForeground': '#c4c8d6',
    'diffEditor.insertedTextBackground': '#3dd68c22',
    'diffEditor.removedTextBackground': '#e5484d26',
    'diffEditor.insertedLineBackground': '#3dd68c12',
    'diffEditor.removedLineBackground': '#e5484d14',
    'diffEditorGutter.insertedLineBackground': '#3dd68c1c',
    'diffEditorGutter.removedLineBackground': '#e5484d1f',
    'diffEditor.unchangedRegionBackground': '#1f2029',
    'diffEditor.border': '#ffffff10',
    'scrollbarSlider.background': '#ffffff12',
    'scrollbarSlider.hoverBackground': '#ffffff22',
    'scrollbarSlider.activeBackground': '#9a5eed40',
  },
});

/** Reads the theme classes `themeStore.ts` puts on `<html>`. Cheap DOM check shared by
 * both Monaco components instead of each re-deriving it (and instead of a store
 * subscription, since these are imperative editor instances outside React's render). */
export function resolveMonacoThemeKey(): 'light' | 'dark' | 'vscode-dark' | 'vs2026' {
  const root = document.documentElement;
  if (root.classList.contains('theme-vscode-dark')) return 'vscode-dark';
  if (root.classList.contains('theme-vs2026')) return 'vs2026';
  return root.classList.contains('dark') ? 'dark' : 'light';
}
