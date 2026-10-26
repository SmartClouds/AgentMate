import * as monaco from 'monaco-editor';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { resolveMonacoThemeKey } from './monacoSetup';

export interface MonacoDiffEditorHandle {
  goToChange: (direction: 'next' | 'previous') => void;
}

/** 1-based, inclusive line ranges on the original (left) and modified (right) side. */
export interface DiffLineRanges {
  original: [number, number][];
  modified: [number, number][];
}

/** Something that can be done to a few changed lines, like staging or discarding them. */
export interface DiffLineAction {
  id: string;
  /** Short button text on a change block, e.g. "Stage". */
  label: string;
  /** The same action in the right-click menu, e.g. "Stage Selected Lines". */
  menuLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'default' | 'danger';
  run: (ranges: DiffLineRanges) => void;
}

export interface MonacoDiffEditorProps {
  /** Picks the syntax highlighting; a new path also resets the view to the top. */
  path: string;
  original: string;
  modified: string;
  sideBySide: boolean;
  ignoreWhitespace: boolean;
  /** Lets the user edit the modified side. The original side always stays read-only. */
  editable?: boolean;
  /** Called with the modified side's text after each edit the user makes. */
  onModifiedChange?: (value: string) => void;
  /**
   * Actions offered on each change block (as buttons when it is hovered) and on the selected
   * lines (in the right-click menu), the way VS Code stages and reverts ranges.
   */
  lineActions?: DiffLineAction[];
  /** Why the line actions can't run right now. They show disabled with this as the hint. */
  lineActionsBlocked?: string;
  className?: string;
}

function currentTheme(): string {
  switch (resolveMonacoThemeKey()) {
    case 'light':
      return 'runova-light';
    case 'dark':
      return 'runova-dark';
    case 'vscode-dark':
      return 'vs-dark';
    case 'vs2026':
      return 'runova-vs2026';
  }
}

/** Monaco's language id for a file, from its extension or exact name. */
export function languageFor(path: string): string {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';
  for (const language of monaco.languages.getLanguages()) {
    if (language.filenames?.some((f) => f.toLowerCase() === name)) return language.id;
    if (ext && language.extensions?.includes(ext)) return language.id;
  }
  return 'plaintext';
}

type Side = 'original' | 'modified';

/** The lines a change block covers on one side, or null when it has none there. */
function blockLines(change: monaco.editor.ILineChange, side: Side): [number, number] | null {
  const start =
    side === 'original' ? change.originalStartLineNumber : change.modifiedStartLineNumber;
  const end = side === 'original' ? change.originalEndLineNumber : change.modifiedEndLineNumber;
  return end > 0 ? [start, end] : null;
}

/**
 * The lines a set of selections touches. A selection that ends at the very start of a line
 * doesn't take that line, and an empty selection means the cursor's line when `cursorLine`.
 */
function selectedLines(editor: monaco.editor.ICodeEditor, cursorLine: boolean): [number, number][] {
  const lines: [number, number][] = [];
  for (const selection of editor.getSelections() ?? []) {
    if (selection.isEmpty()) {
      if (cursorLine) lines.push([selection.startLineNumber, selection.startLineNumber]);
      continue;
    }
    const end =
      selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
        ? selection.endLineNumber - 1
        : selection.endLineNumber;
    lines.push([selection.startLineNumber, end]);
  }
  return lines;
}

function intersect(ranges: [number, number][], block: [number, number] | null): [number, number][] {
  if (!block) return [];
  return ranges
    .map(([from, to]): [number, number] => [Math.max(from, block[0]), Math.min(to, block[1])])
    .filter(([from, to]) => from <= to);
}

/** Every line a block covers, on both sides. */
function wholeBlock(change: monaco.editor.ILineChange): DiffLineRanges {
  const original = blockLines(change, 'original');
  const modified = blockLines(change, 'modified');
  return { original: original ? [original] : [], modified: modified ? [modified] : [] };
}

function sameBlock(a: monaco.editor.ILineChange, b: monaco.editor.ILineChange): boolean {
  return (
    a.originalStartLineNumber === b.originalStartLineNumber &&
    a.originalEndLineNumber === b.originalEndLineNumber &&
    a.modifiedStartLineNumber === b.modifiedStartLineNumber &&
    a.modifiedEndLineNumber === b.modifiedEndLineNumber
  );
}

function lineCount(ranges: DiffLineRanges): number {
  return [...ranges.original, ...ranges.modified].reduce(
    (sum, [from, to]) => sum + to - from + 1,
    0,
  );
}

interface HoveredBlock {
  change: monaco.editor.ILineChange;
  side: Side;
  top: number;
  right: number;
}

/** A side-by-side (or inline) diff of two versions of a file, optionally editable on the right. */
export const MonacoDiffEditor = forwardRef<MonacoDiffEditorHandle, MonacoDiffEditorProps>(
  function MonacoDiffEditor(
    {
      path,
      original,
      modified,
      sideBySide,
      ignoreWhitespace,
      editable = false,
      onModifiedChange,
      lineActions,
      lineActionsBlocked,
      className,
    },
    ref,
  ) {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const onModifiedChangeRef = useRef(onModifiedChange);
    onModifiedChangeRef.current = onModifiedChange;
    // Set while new content from outside is loaded, so only the user's own edits are reported.
    const applyingRef = useRef(false);
    const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
    const modelsRef = useRef<{
      path: string;
      original: monaco.editor.ITextModel;
      modified: monaco.editor.ITextModel;
    } | null>(null);
    const [hovered, setHovered] = useState<HoveredBlock | null>(null);
    const hoveredRef = useRef<HoveredBlock | null>(null);
    hoveredRef.current = hovered;
    const hideTimer = useRef<number | null>(null);
    // Bumped when the selection moves, so the block buttons can say how many lines they take.
    const [, setSelectionTick] = useState(0);

    useImperativeHandle(ref, () => ({
      goToChange: (direction) => editorRef.current?.goToDiff(direction),
    }));

    // biome-ignore lint/correctness/useExhaustiveDependencies: created once; option and content changes are applied by the effects below
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const editor = monaco.editor.createDiffEditor(container, {
        theme: currentTheme(),
        // The context menu stays in the page's DOM so index.css can theme it; in a shadow root it can't.
        useShadowDOM: false,
        readOnly: !editable,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: sideBySide,
        useInlineViewWhenSpaceIsLimited: true,
        renderSideBySideInlineBreakpoint: 700,
        ignoreTrimWhitespace: ignoreWhitespace,
        hideUnchangedRegions: { enabled: true, contextLineCount: 4, minimumLineCount: 6 },
        renderOverviewRuler: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12.5,
        lineHeight: 19,
        fontFamily:
          "'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        renderLineHighlight: 'none',
        stickyScroll: { enabled: false },
        padding: { top: 8 },
        diffAlgorithm: 'advanced',
      });
      editorRef.current = editor;

      // Listens on the editor, not a model, so it keeps working when the file is swapped.
      const modifiedEditor = editor.getModifiedEditor();
      const contentListener = modifiedEditor.onDidChangeModelContent(() => {
        if (applyingRef.current) return;
        onModifiedChangeRef.current?.(modifiedEditor.getValue());
      });

      const themeObserver = new MutationObserver(() => monaco.editor.setTheme(currentTheme()));
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      });

      return () => {
        themeObserver.disconnect();
        contentListener.dispose();
        editor.dispose();
        // Models outlive the editor in Monaco's registry; leaving them is how diffs leak.
        modelsRef.current?.original.dispose();
        modelsRef.current?.modified.dispose();
        modelsRef.current = null;
        editorRef.current = null;
      };
    }, []);

    useEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const current = modelsRef.current;
      if (current && current.path === path) {
        // Same file, new content (it changed on disk): keep the scroll position.
        applyingRef.current = true;
        try {
          if (current.original.getValue() !== original) current.original.setValue(original);
          if (current.modified.getValue() !== modified) current.modified.setValue(modified);
        } finally {
          applyingRef.current = false;
        }
        return;
      }
      const language = languageFor(path);
      const next = {
        path,
        original: monaco.editor.createModel(original, language),
        modified: monaco.editor.createModel(modified, language),
      };
      applyingRef.current = true;
      try {
        editor.setModel({ original: next.original, modified: next.modified });
      } finally {
        applyingRef.current = false;
      }
      current?.original.dispose();
      current?.modified.dispose();
      modelsRef.current = next;
    }, [path, original, modified]);

    useEffect(() => {
      editorRef.current?.updateOptions({
        renderSideBySide: sideBySide,
        ignoreTrimWhitespace: ignoreWhitespace,
        readOnly: !editable,
      });
    }, [sideBySide, ignoreWhitespace, editable]);

    const hasLineActions = (lineActions?.length ?? 0) > 0;

    /**
     * Where a block's buttons go: level with its first line, at the right edge of that side. A
     * block that starts above the view keeps them pinned to the top while any of it shows.
     */
    function placeBlock(change: monaco.editor.ILineChange, side: Side): HoveredBlock | null {
      const diff = editorRef.current;
      const wrapper = wrapperRef.current;
      if (!diff || !wrapper) return null;
      const editor = side === 'original' ? diff.getOriginalEditor() : diff.getModifiedEditor();
      const dom = editor.getDomNode();
      if (!dom) return null;
      const lines = blockLines(change, side);
      const start = Math.max(
        1,
        lines?.[0] ??
          (side === 'original' ? change.originalStartLineNumber : change.modifiedStartLineNumber),
      );
      const end = lines?.[1] ?? start;
      const outer = wrapper.getBoundingClientRect();
      const box = dom.getBoundingClientRect();
      const viewTop = box.top - outer.top;
      const scrollTop = editor.getScrollTop();
      const blockTop = viewTop + editor.getTopForLineNumber(start) - scrollTop;
      const blockBottom =
        viewTop +
        editor.getTopForLineNumber(end) +
        editor.getOption(monaco.editor.EditorOption.lineHeight) -
        scrollTop;
      if (blockBottom <= viewTop || blockTop > box.bottom - outer.top - 16) return null;
      const top = Math.max(blockTop, viewTop);
      const scrollbar = editor.getLayoutInfo().verticalScrollbarWidth;
      return { change, side, top, right: outer.right - box.right + scrollbar + 8 };
    }

    // Tracks the change block under the pointer on either side, and keeps its buttons in place
    // while the view scrolls.
    // biome-ignore lint/correctness/useExhaustiveDependencies: placeBlock only reads refs
    useEffect(() => {
      const diff = editorRef.current;
      if (!diff || !hasLineActions) {
        setHovered(null);
        return;
      }
      const cancelHide = (): void => {
        if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      };
      const scheduleHide = (): void => {
        cancelHide();
        hideTimer.current = window.setTimeout(() => setHovered(null), 250);
      };

      const listen = (editor: monaco.editor.ICodeEditor, side: Side): monaco.IDisposable[] => [
        editor.onMouseMove((event) => {
          const changes = diff.getLineChanges() ?? [];
          const target = event.target;
          let change: monaco.editor.ILineChange | undefined;
          if (target.position) {
            const line = target.position.lineNumber;
            change = changes.find((c) => {
              const lines = blockLines(c, side);
              return lines !== null && line >= lines[0] && line <= lines[1];
            });
          }
          // In the inline view removed lines are a zone between two lines of the modified file.
          if (
            !change &&
            side === 'modified' &&
            (target.type === monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE ||
              target.type === monaco.editor.MouseTargetType.GUTTER_VIEW_ZONE)
          ) {
            const after = (target.detail as { afterLineNumber?: number }).afterLineNumber;
            change = changes.find((c) =>
              c.modifiedEndLineNumber === 0
                ? c.modifiedStartLineNumber === after
                : c.modifiedStartLineNumber - 1 === after,
            );
          }
          if (!change) {
            if (hoveredRef.current) scheduleHide();
            return;
          }
          cancelHide();
          const current = hoveredRef.current;
          if (current && current.side === side && sameBlock(current.change, change)) return;
          // A block with nothing on this side (an addition, seen from the left) sits on the
          // line it goes after, which is fine to hang the buttons on too.
          setHovered(placeBlock(change, side));
        }),
        editor.onMouseLeave(scheduleHide),
        editor.onDidScrollChange(() => {
          const current = hoveredRef.current;
          if (current?.side === side) setHovered(placeBlock(current.change, side));
        }),
        editor.onDidChangeCursorSelection(() => setSelectionTick((tick) => tick + 1)),
      ];

      const disposables = [
        ...listen(diff.getOriginalEditor(), 'original'),
        ...listen(diff.getModifiedEditor(), 'modified'),
        diff.onDidUpdateDiff(() => setHovered(null)),
      ];
      return () => {
        cancelHide();
        for (const disposable of disposables) disposable.dispose();
      };
    }, [hasLineActions]);

    const lineActionsRef = useRef(lineActions);
    lineActionsRef.current = lineActions;

    // The same actions in the right-click menu, run on the selection (or the cursor's line).
    const actionKey = lineActionsBlocked
      ? ''
      : (lineActions ?? []).map((action) => `${action.id}:${action.menuLabel}`).join('|');
    useEffect(() => {
      const diff = editorRef.current;
      if (!diff || !actionKey) return;
      const disposables: monaco.IDisposable[] = [];
      for (const [side, editor] of [
        ['original', diff.getOriginalEditor()],
        ['modified', diff.getModifiedEditor()],
      ] as const) {
        (lineActionsRef.current ?? []).forEach((action, index) => {
          disposables.push(
            editor.addAction({
              id: `runova.diff.lines.${action.id}`,
              label: action.menuLabel,
              contextMenuGroupId: '0_runova_lines',
              contextMenuOrder: index,
              run: (ed) => {
                const lines = selectedLines(ed, true);
                const latest = lineActionsRef.current?.find((a) => a.id === action.id);
                latest?.run({
                  original: side === 'original' ? lines : [],
                  modified: side === 'modified' ? lines : [],
                });
              },
            }),
          );
        });
      }
      return () => {
        for (const disposable of disposables) disposable.dispose();
      };
    }, [actionKey]);

    /** The lines a block's buttons act on: the selected part of the block, or all of it. */
    function blockRanges(change: monaco.editor.ILineChange): DiffLineRanges {
      const diff = editorRef.current;
      const whole = wholeBlock(change);
      if (!diff) return whole;
      // A hidden left side (inline view) keeps an empty selection, which picks nothing.
      const picked: DiffLineRanges = {
        original: intersect(
          selectedLines(diff.getOriginalEditor(), false),
          whole.original[0] ?? null,
        ),
        modified: intersect(
          selectedLines(diff.getModifiedEditor(), false),
          whole.modified[0] ?? null,
        ),
      };
      return lineCount(picked) > 0 ? picked : whole;
    }

    const blockToolbar =
      hasLineActions && hovered
        ? (() => {
            const ranges = blockRanges(hovered.change);
            const count = lineCount(ranges);
            const whole = count === lineCount(wholeBlock(hovered.change));
            return (
              <div
                role="toolbar"
                aria-label="Change block actions"
                onMouseEnter={() => {
                  if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
                  hideTimer.current = null;
                }}
                onMouseLeave={() => {
                  hideTimer.current = window.setTimeout(() => setHovered(null), 250);
                }}
                style={{ top: hovered.top, right: hovered.right }}
                className="absolute z-10 flex h-[19px] items-center gap-px overflow-hidden rounded-md border border-border bg-popover/95 shadow-sm backdrop-blur-sm"
              >
                {lineActions?.map((action) => {
                  const Icon = action.icon;
                  const hint = lineActionsBlocked
                    ? lineActionsBlocked
                    : whole
                      ? `${action.label} this block`
                      : `${action.label} the ${count} selected line${count === 1 ? '' : 's'}`;
                  return (
                    <SimpleTooltip
                      key={action.id}
                      label={hint}
                      wrapTrigger={!!lineActionsBlocked}
                      delayDuration={400}
                    >
                      <button
                        type="button"
                        aria-label={hint}
                        disabled={!!lineActionsBlocked}
                        onClick={() => {
                          action.run(ranges);
                          setHovered(null);
                        }}
                        className={cn(
                          'flex h-full items-center gap-1 px-1.5 text-[10.5px] font-medium text-muted-foreground transition-colors disabled:pointer-events-none disabled:opacity-50',
                          action.tone === 'danger'
                            ? 'hover:bg-destructive/15 hover:text-destructive'
                            : 'hover:bg-primary/15 hover:text-primary',
                        )}
                      >
                        <Icon className="h-2.5 w-2.5" />
                        {whole ? action.label : `${action.label} ${count}`}
                      </button>
                    </SimpleTooltip>
                  );
                })}
              </div>
            );
          })()
        : null;

    return (
      <div ref={wrapperRef} className={cn('relative h-full w-full overflow-hidden', className)}>
        <div ref={containerRef} className="h-full w-full" />
        {blockToolbar}
      </div>
    );
  },
);
