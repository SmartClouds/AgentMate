import { isImagePath, isTextImagePath } from '@shared/imageFiles';
import { useQuery } from '@tanstack/react-query';
import * as monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { formatImageSize, type ImageSize, ImageView } from '@/components/editor/ImageView';
import { languageFor } from '@/components/editor/MonacoDiffEditor';
import { currentMonacoTheme } from '@/components/editor/MonacoEditor';
import { File, ImageIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useWorkspaceSearchStore } from '@/stores/workspaceSearchStore';

/** The file a result points at, and where in it. */
export interface PreviewTarget {
  /** The full path on disk. */
  path: string;
  /** Relative to the project, for the header. */
  relative: string;
  line?: number;
  column?: number;
  /** How many characters of the line matched. */
  length?: number;
}

/** Arrowing through results should not read a file per row it passes. */
const SETTLE_MS = 80;
/** Past this a preview is more wait than help; the file opens in a tab instead. */
const MAX_PREVIEW_CHARS = 2_000_000;

function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/**
 * Whether a result is shown as a picture. An SVG that a text match led to shows its source
 * instead, since the matched line is the point.
 */
function isPicture(target: PreviewTarget | null | undefined): boolean {
  if (!target || !isImagePath(target.path)) return false;
  return !(isTextImagePath(target.path) && target.line !== undefined);
}

function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes('\0');
}

/**
 * One read-only editor, made the first time there is a file to show and then reused: a new
 * result swaps its text and moves the highlight, which is far cheaper than a new editor.
 */
function PreviewEditor({
  path,
  text,
  line,
  column,
  length,
}: {
  path: string;
  text: string;
  line?: number;
  column?: number;
  length?: number;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const shownRef = useRef<{ path: string; text: string } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const editor = monaco.editor.create(containerRef.current, {
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      theme: currentMonacoTheme(),
      fontSize: 12,
      minimap: { enabled: false },
      folding: false,
      glyphMargin: false,
      lineDecorationsWidth: 6,
      renderLineHighlight: 'none',
      contextmenu: false,
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      stickyScroll: { enabled: false },
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      matchBrackets: 'never',
      wordWrap: 'off',
    });
    editorRef.current = editor;
    decorationsRef.current = editor.createDecorationsCollection();
    const themeObserver = new MutationObserver(() => monaco.editor.setTheme(currentMonacoTheme()));
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => {
      themeObserver.disconnect();
      const model = editor.getModel();
      editor.dispose();
      model?.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const shown = shownRef.current;
    // Moving between matches in one file only moves the highlight.
    if (!shown || shown.path !== path || shown.text !== text) {
      const previous = editor.getModel();
      editor.setModel(monaco.editor.createModel(text, languageFor(path.replaceAll('\\', '/'))));
      previous?.dispose();
      shownRef.current = { path, text };
    }
    const decorations = decorationsRef.current;
    if (!line) {
      decorations?.clear();
      editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
      return;
    }
    const start = column ?? 1;
    const match = new monaco.Range(line, start, line, start + (length ?? 0));
    decorations?.set([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: 'workspace-search-line' },
      },
      ...(length ? [{ range: match, options: { inlineClassName: 'workspace-search-match' } }] : []),
    ]);
    editor.revealRangeInCenter(match);
  }, [path, text, line, column, length]);

  return <div ref={containerRef} className="absolute inset-0" />;
}

/** The bottom half of the search dialog: the selected result in its file. */
export function SearchPreview({ target }: { target: PreviewTarget | null }): React.JSX.Element {
  const settled = useSettled(target, SETTLE_MS);
  const showImages = useWorkspaceSearchStore((s) => s.preview.images);
  const setPreview = useWorkspaceSearchStore((s) => s.setPreview);
  const path = settled?.path ?? null;
  const image = isPicture(settled);
  const file = useQuery({
    queryKey: queryKeys.workspaceFile(path ?? ''),
    queryFn: () => window.runova.fs.readFile(path as string),
    enabled: path !== null && !image,
    meta: { silentLoading: true },
    staleTime: 5000,
  });
  // The same cache the image tab reads, so opening the picture afterwards is instant.
  const picture = useQuery({
    queryKey: queryKeys.workspaceImage(path ?? ''),
    queryFn: () => window.runova.fs.readImage(path as string),
    enabled: path !== null && image && showImages,
    meta: { silentLoading: true },
    staleTime: 5000,
  });
  const [size, setSize] = useState<ImageSize | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new file is the trigger
  useEffect(() => setSize(null), [path]);

  const name = target?.relative.split('/').pop() ?? '';
  const dir = target
    ? target.relative.slice(0, Math.max(0, target.relative.length - name.length - 1))
    : '';
  const text = file.data;
  const targetIsPicture = isPicture(target);
  const caption =
    targetIsPicture && showImages && settled?.path === target?.path
      ? [formatImageSize(size), picture.data ? formatBytes(picture.data.bytes) : null]
          .filter(Boolean)
          .join(' · ')
      : '';

  let body: React.ReactNode;
  if (!target) {
    body = <PreviewMessage text="Pick a result to see it here." />;
  } else if (targetIsPicture && !showImages) {
    body = (
      <PreviewMessage
        icon="image"
        text="Picture previews are off. Press Enter to open it in the viewer."
      />
    );
  } else if (image && settled?.path === target.path) {
    body = picture.isError ? (
      <PreviewMessage
        icon="image"
        text={
          picture.error instanceof Error
            ? picture.error.message
            : 'This picture could not be read. It may have been moved or deleted.'
        }
      />
    ) : picture.data ? (
      // The viewer grows into a flex column; the preview body is only a positioned box.
      <div className="absolute inset-0 flex flex-col">
        <ImageView src={picture.data.dataUrl} alt={name} onSize={setSize} />
      </div>
    ) : (
      <div className="flex h-full items-center justify-center p-4" aria-hidden>
        <Skeleton className="h-full w-full max-w-md rounded-lg" />
      </div>
    );
  } else if (file.isError) {
    body = (
      <PreviewMessage text="This file could not be read. It may have been moved or deleted." />
    );
  } else if (text === undefined || settled?.path !== target.path) {
    body = (
      <div className="space-y-2 p-3" aria-hidden>
        {Array.from({ length: 8 }, (_, row) => (
          <Skeleton
            key={row}
            className="h-3 rounded"
            style={{ width: `${30 + ((row * 37) % 55)}%` }}
          />
        ))}
      </div>
    );
  } else if (text.length > MAX_PREVIEW_CHARS) {
    body = <PreviewMessage text="This file is too large to preview. Press Enter to open it." />;
  } else if (looksBinary(text)) {
    body = <PreviewMessage text="This looks like a binary file, so there is nothing to preview." />;
  } else {
    body = (
      <PreviewEditor
        path={target.path}
        text={text}
        line={settled.line}
        column={settled.column}
        length={settled.length}
      />
    );
  }

  return (
    <section aria-label="Preview" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-7 shrink-0 items-center gap-1.5 px-3.5 text-[11px] shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
        {target ? (
          <>
            {targetIsPicture ? (
              <ImageIcon className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
            ) : (
              <File className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
            )}
            <span className="shrink-0 font-medium">{name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground [direction:rtl]">
              <bdi>{dir}</bdi>
            </span>
            {targetIsPicture ? (
              <>
                {caption ? (
                  <span className="shrink-0 tabular-nums text-muted-foreground">{caption}</span>
                ) : null}
                <SimpleTooltip
                  label={showImages ? 'Hide picture previews' : 'Show picture previews'}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={showImages ? 'Hide picture previews' : 'Show picture previews'}
                    aria-pressed={showImages}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setPreview({ images: !showImages })}
                    className={cn(
                      'h-5 w-5 [&_svg]:size-2.5',
                      showImages && 'text-primary hover:bg-primary/15 hover:text-primary',
                    )}
                  >
                    <ImageIcon />
                  </Button>
                </SimpleTooltip>
              </>
            ) : (
              <span className="shrink-0 tabular-nums text-muted-foreground">
                Ln {target.line ?? 1}, Ch {target.column ?? 1}
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">Preview</span>
        )}
      </header>
      <div className="relative min-h-0 flex-1">{body}</div>
    </section>
  );
}

function PreviewMessage({ text, icon }: { text: string; icon?: 'image' }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center text-xs text-muted-foreground">
      {icon === 'image' ? <ImageIcon className="h-4 w-4" /> : null}
      {text}
    </div>
  );
}
