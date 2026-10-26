import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { GitChangeStatus, Project } from '@runova/core';
import type { TextSearchOptions, WorkspaceGitState } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Search, X } from '@/components/icons';
import { FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import {
  type FileSearchResult,
  loweredPaths,
  searchFiles,
  toAbsolutePath,
} from '@/components/workspace/git/explorer/fileSearch';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import {
  MODE_PREFIX,
  nextMode,
  parseSearchQuery,
  SEARCH_MODES,
  type SearchMode,
  withMode,
} from '@/lib/workspaceSearch/query';
import { buildRows, firstSelectable, nextSelectable, type Row } from '@/lib/workspaceSearch/rows';
import { type SymbolSearchResult, searchSymbols } from '@/lib/workspaceSearch/symbols';
import type { RevealTarget } from '@/stores/editorRevealStore';
import { useRecentFilesStore } from '@/stores/recentFilesStore';
import { commandForEvent, useShortcutLabel, useShortcutStore } from '@/stores/shortcutStore';
import {
  PREVIEW_DEFAULT,
  PREVIEW_MAX,
  PREVIEW_MIN,
  useWorkspaceSearchStore,
} from '@/stores/workspaceSearchStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { type PreviewTarget, SearchPreview } from './SearchPreview';
import { ROW_HEIGHT, SearchRow } from './SearchRow';
import { useSymbolIndex } from './useSymbolIndex';
import { type TextSearchPlan, useTextSearch } from './useTextSearch';

const NO_FILES: string[] = [];
const NO_FILE_HITS: FileSearchResult = { hits: [], total: 0 };
const NO_SYMBOL_HITS: SymbolSearchResult = { hits: [], total: 0 };
/** How many selectable rows PageUp and PageDown skip. */
const PAGE_STEP = 10;

const MODE_LABEL: Record<SearchMode, string> = {
  all: 'All',
  files: 'Files',
  types: 'Types',
  members: 'Members',
  text: 'Text',
};

/** Text search waits for a pause in typing, longer in All where it runs beside everything else. */
const TEXT_PLANS: Partial<Record<SearchMode, TextSearchPlan>> = {
  text: { delayMs: 150, minChars: 2 },
  all: { delayMs: 250, minChars: 3, maxMatches: 200 },
};

const OPTION_TOGGLES: {
  option: keyof TextSearchOptions;
  label: string;
  glyph: string;
  key: string;
}[] = [
  { option: 'matchCase', label: 'Match case', glyph: 'Aa', key: 'KeyC' },
  { option: 'wholeWord', label: 'Match whole word', glyph: 'ab', key: 'KeyW' },
  { option: 'regex', label: 'Use regular expression', glyph: '.*', key: 'KeyR' },
];

interface OpenTarget {
  relative: string;
  reveal?: RevealTarget;
}

/** Where a row leads: its file, and the place in it when the row has one. */
function targetOf(
  row: Row | undefined,
  line: number | undefined,
  column: number | undefined,
): OpenTarget | null {
  switch (row?.kind) {
    case 'file':
      return { relative: row.hit.path, reveal: line ? { line, column: column ?? 1 } : undefined };
    case 'recent':
      return { relative: row.path };
    case 'symbol':
      return {
        relative: row.hit.path,
        reveal: { line: row.hit.line, column: row.hit.column, length: row.hit.name.length },
      };
    case 'textLine': {
      const [first] = row.match.ranges;
      return {
        relative: row.path,
        reveal: {
          line: row.match.line,
          column: row.match.column,
          ...(first ? { length: first[1] - first[0] } : {}),
        },
      };
    }
    case 'textFile':
      return { relative: row.path };
    default:
      return null;
  }
}

/** A path from the recent list, relative to the project, or null when it sits elsewhere. */
function relativeTo(root: string, path: string): string | null {
  const base = root.replace(/[\\/]+$/, '');
  const fold = (value: string) => value.replaceAll('\\', '/').toLowerCase();
  if (!fold(path).startsWith(`${fold(base)}/`)) return null;
  return path.slice(base.length + 1).replaceAll('\\', '/');
}

/**
 * The workspace's Go to All, after Visual Studio's: one box that finds files by name, types
 * and members by declaration, and text in files, with a preview of the selected result.
 */
export function WorkspaceSearchDialog({ project }: { project: Project }): React.JSX.Element {
  const open = useWorkspaceSearchStore((s) => s.open && s.projectId === project.id);
  const close = useWorkspaceSearchStore((s) => s.close);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/20 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(event) => event.preventDefault()}
          className={cn(
            // The command palette's frosted panel, which brings its own edge, tint and corners.
            'search-panel fixed left-1/2 top-[7vh] z-50 flex h-[min(700px,84vh)] w-[min(940px,94vw)] -translate-x-1/2 flex-col text-popover-foreground',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
            'data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98]',
          )}
        >
          <DialogPrimitive.Title className="sr-only">Search {project.name}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Find files, types, members and text in this project. Type f:, t:, m: or x: to search
            only one of them.
          </DialogPrimitive.Description>
          <SearchPanel project={project} onClose={close} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SearchPanel({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}): React.JSX.Element {
  const projectId = project.id;
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const raw = useWorkspaceSearchStore((s) => s.queries[projectId] ?? '');
  const setQueryFor = useWorkspaceSearchStore((s) => s.setQuery);
  const options = useWorkspaceSearchStore((s) => s.options);
  const setOption = useWorkspaceSearchStore((s) => s.setOption);
  const preview = useWorkspaceSearchStore((s) => s.preview);
  const setPreview = useWorkspaceSearchStore((s) => s.setPreview);
  const setQuery = useCallback(
    (next: string) => setQueryFor(projectId, next),
    [projectId, setQueryFor],
  );

  const parsed = useMemo(() => parseSearchQuery(raw), [raw]);
  // The box and tabs follow every keystroke; ranking catches up a frame later on a big project.
  const settled = useDeferredValue(parsed);
  const mode = settled.mode;
  const query = mode === 'text' ? settled.text : settled.text.trim();
  const wants = (kind: SearchMode) => mode === 'all' || mode === kind;
  const wantFiles = wants('files');
  const wantTypes = wants('types');
  const wantMembers = wants('members');

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // The split is saved as a share of the height; the handle works in pixels.
  const [bodyHeight, setBodyHeight] = useState(0);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setBodyHeight(body.clientHeight));
    observer.observe(body);
    setBodyHeight(body.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Files: the explorer's own list, shared with its search box, ranked here on every keystroke.
  const index = useQuery({
    queryKey: queryKeys.workspaceExplorerFiles(projectId),
    queryFn: () => window.runova.explorer.listFiles(projectId),
    meta: { silentLoading: true },
    staleTime: 30_000,
  });
  const files = index.data?.files ?? NO_FILES;
  const root = index.data?.root ?? project.folderPath;
  const lowered = useMemo(() => loweredPaths(files), [files]);
  const fileHits = useMemo(
    () => (wantFiles && query ? searchFiles(files, query, { lowered }) : NO_FILE_HITS),
    [wantFiles, files, lowered, query],
  );

  // Types and members: fetched as the dialog opens, so they are ready by the time `t:` is typed.
  const symbols = useSymbolIndex(projectId, true);
  const typeHits = useMemo(
    () =>
      wantTypes && query && symbols.index && symbols.views
        ? searchSymbols(symbols.index, symbols.views.types, query)
        : NO_SYMBOL_HITS,
    [wantTypes, symbols.index, symbols.views, query],
  );
  const memberHits = useMemo(
    () =>
      wantMembers && query && symbols.index && symbols.views
        ? searchSymbols(symbols.index, symbols.views.members, query)
        : NO_SYMBOL_HITS,
    [wantMembers, symbols.index, symbols.views, query],
  );

  // Text: ripgrep in the main process, streamed in as it finds matches.
  const text = useTextSearch(
    projectId,
    parsed.mode === 'text' ? parsed.text : parsed.text.trim(),
    options,
    TEXT_PLANS[parsed.mode] ?? null,
  );

  const recentPaths = useRecentFilesStore((s) => s.byProject[projectId] ?? NO_FILES);
  const known = useMemo(() => new Set(files), [files]);
  const recent = useMemo(
    () =>
      recentPaths
        .map((path) => relativeTo(root, path))
        .filter((path): path is string => path !== null && (!index.data || known.has(path))),
    [recentPaths, root, index.data, known],
  );

  // Git status letters, from the changes panel's copy; the panel keeps it current.
  const gitState = useQuery<WorkspaceGitState>({
    queryKey: queryKeys.gitWorkspaceState(projectId),
    queryFn: () => window.runova.git.workspaceState(projectId),
    enabled: false,
  });
  const statusByPath = useMemo(() => {
    const map = new Map<string, GitChangeStatus>();
    const state = gitState.data;
    if (!state) return map;
    for (const entry of [...state.unstaged, ...state.staged]) map.set(entry.path, entry.status);
    for (const entry of state.untracked) map.set(entry.path, '?');
    for (const entry of state.conflicts) map.set(entry.path, 'U');
    return map;
  }, [gitState.data]);
  const prefix = gitState.data?.projectPrefix ?? '';

  const loading =
    (wants('files') && index.isPending) ||
    ((wants('types') || wants('members')) && symbols.isPending) ||
    (wants('text') && text.running);

  const rows = useMemo<Row[]>(() => {
    if (query && mode === 'text' && text.summary?.error) {
      return [{ kind: 'hint', key: 'hint', text: text.summary.error }];
    }
    if (query && (mode === 'types' || mode === 'members') && symbols.index?.unavailable) {
      return [
        {
          kind: 'hint',
          key: 'hint',
          text: 'Searching types and members is not available in this build.',
        },
      ];
    }
    return buildRows({
      mode,
      query,
      files: fileHits,
      types: typeHits,
      members: memberHits,
      text: text.results,
      recent,
      pending: loading,
    });
  }, [
    mode,
    query,
    fileHits,
    typeHits,
    memberHits,
    text.results,
    text.summary,
    symbols.index,
    recent,
    loading,
  ]);

  // The selection follows a row by key, so streamed text matches never move it, and starts
  // over at the top whenever the query changes.
  const queryKey = `${mode}\n${query}`;
  const [selection, setSelection] = useState<{ key: string; query: string } | null>(null);
  let activeIndex =
    selection?.query === queryKey ? rows.findIndex((row) => row.key === selection.key) : -1;
  if (activeIndex === -1) activeIndex = firstSelectable(rows);
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;

  const virtual = useVirtualRows(rows.length, ROW_HEIGHT);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;

  const select = useCallback(
    (at: number) => {
      const row = rowsRef.current[at];
      if (!row) return;
      setSelection({ key: row.key, query: queryKeyRef.current });
      virtual.scrollToIndex(at);
    },
    [virtual.scrollToIndex],
  );

  const openRow = useCallback(
    (row: Row | undefined, how: 'pin' | 'preview' | 'side') => {
      if (row?.kind === 'more') {
        setQuery(withMode(raw, row.mode));
        inputRef.current?.focus();
        return;
      }
      const target = targetOf(row, settled.line, settled.column);
      if (!target) return;
      const path = toAbsolutePath(root, target.relative);
      const store = useWorkspaceStore.getState();
      const reveal = target.reveal ? { reveal: target.reveal } : {};
      if (how === 'preview') {
        store.openFile(projectId, path, { pin: false, ...reveal });
        return;
      }
      if (how === 'side') {
        const groupId = store.workspaces[projectId]?.focusedGroupId;
        if (groupId) store.splitGroup(projectId, groupId, 'row');
      }
      store.openFile(projectId, path, { pin: true, ...reveal });
      onClose();
    },
    [projectId, raw, root, settled.line, settled.column, setQuery, onClose],
  );

  const openAt = useCallback((at: number) => openRow(rowsRef.current[at], 'pin'), [openRow]);

  function step(direction: 1 | -1, times = 1): void {
    let at = activeIndex;
    for (let moved = 0; moved < times; moved += 1) {
      const next = nextSelectable(rows, at, direction);
      // Paging stops at the ends instead of wrapping round.
      if (next === -1 || (times > 1 && (direction === 1 ? next < at : next > at))) break;
      at = next;
    }
    if (at !== -1) select(at);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      step(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      step(event.key === 'PageDown' ? 1 : -1, PAGE_STEP);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openRow(
        activeRow,
        event.ctrlKey || event.metaKey ? 'side' : event.shiftKey ? 'preview' : 'pin',
      );
    } else if (event.key === 'Tab' && plain) {
      event.preventDefault();
      setQuery(withMode(raw, nextMode(parsed.mode, event.shiftKey ? -1 : 1)));
    } else if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const toggle = OPTION_TOGGLES.find((one) => one.key === event.code);
      if (toggle) {
        event.preventDefault();
        setOption(toggle.option, !options[toggle.option]);
      }
    } else if (
      commandForEvent(
        event.nativeEvent,
        useShortcutStore.getState().overrides,
        true,
        'workspace',
      ) === 'workspace.search'
    ) {
      // Pressing the shortcut again, as in VS Code, starts a fresh query over the old one.
      event.preventDefault();
      inputRef.current?.select();
    }
  }

  const previewTarget = useMemo<PreviewTarget | null>(() => {
    const target = targetOf(activeRow, settled.line, settled.column);
    if (!target) return null;
    return {
      path: toAbsolutePath(root, target.relative),
      relative: target.relative,
      line: target.reveal?.line,
      column: target.reveal?.column,
      length: target.reveal?.length,
    };
  }, [activeRow, root, settled.line, settled.column]);

  const counts: Partial<Record<SearchMode, string>> = query
    ? {
        ...(wants('files') && !index.isPending ? { files: fileHits.total.toLocaleString() } : {}),
        ...(wants('types') && symbols.index ? { types: typeHits.total.toLocaleString() } : {}),
        ...(wants('members') && symbols.index
          ? { members: memberHits.total.toLocaleString() }
          : {}),
        ...(wants('text') && text.summary && !text.summary.error
          ? { text: `${text.summary.matches.toLocaleString()}${text.summary.truncated ? '+' : ''}` }
          : {}),
      }
    : {};

  const listId = `workspace-search-list-${projectId}`;
  const optionId = (at: number) => `workspace-search-${projectId}-${at}`;
  const showSkeleton =
    loading && !rows.some((row) => row.kind !== 'hint' && row.kind !== 'section');
  const stale = parsed !== settled || text.stale;

  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-1 px-2">
        <div
          role="tablist"
          aria-label="What to search"
          className="flex min-w-0 flex-1 items-center gap-0.5"
        >
          {SEARCH_MODES.map((one) => (
            <button
              key={one}
              type="button"
              role="tab"
              aria-selected={parsed.mode === one}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setQuery(withMode(raw, one))}
              // Pills like the kit's PillTabs, kept as real tabs so the mode stays a tablist.
              className={cn(
                'relative flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                parsed.mode === one
                  ? 'bg-primary/12 text-primary ring-1 ring-inset ring-primary/20'
                  : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
              )}
            >
              {MODE_LABEL[one]}
              {one !== 'all' ? (
                <span className="font-mono text-[10px] font-normal opacity-60">
                  {MODE_PREFIX[one]}
                </span>
              ) : null}
              {counts[one] !== undefined ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[10px] tabular-nums',
                    parsed.mode === one
                      ? 'bg-primary/15 text-primary'
                      : 'bg-foreground/[0.08] text-muted-foreground',
                  )}
                >
                  {counts[one]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <SimpleTooltip label={preview.visible ? 'Hide preview' : 'Show preview'}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={preview.visible ? 'Hide preview' : 'Show preview'}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setPreview({ visible: !preview.visible })}
          >
            {preview.visible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Close (Esc)">
          <Button variant="ghost" size="icon-sm" aria-label="Close search" onClick={onClose}>
            <X className="h-3 w-3" />
          </Button>
        </SimpleTooltip>
      </div>

      {/* The palette's search pill. The progress line runs along the hairline under it. */}
      <div className="relative shrink-0 px-2 pb-2">
        <div className="search-pill flex h-9 items-center gap-2 rounded-full pl-3.5 pr-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeRow ? optionId(activeIndex) : undefined}
            aria-label="Search files, types, members and text"
            placeholder="Search, or start with f: t: m: x: to narrow it"
            spellCheck={false}
            autoComplete="off"
            value={raw}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
          />
          <div className="flex shrink-0 items-center gap-0.5">
            {OPTION_TOGGLES.map((toggle) => (
              <SimpleTooltip
                key={toggle.option}
                label={`${toggle.label} (Alt+${toggle.key.slice(3)})`}
              >
                <button
                  type="button"
                  aria-label={toggle.label}
                  aria-pressed={options[toggle.option]}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setOption(toggle.option, !options[toggle.option])}
                  className={cn(
                    'flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-full px-1.5 font-mono text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    options[toggle.option]
                      ? 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/35'
                      : 'text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground',
                  )}
                >
                  {toggle.glyph}
                </button>
              </SimpleTooltip>
            ))}
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden bg-foreground/[0.08]">
          {text.running || (loading && !showSkeleton) ? (
            <div className="search-progress absolute inset-0" />
          ) : null}
        </div>
      </div>

      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        <div
          ref={virtual.containerRef}
          onScroll={virtual.onScroll}
          id={listId}
          role="listbox"
          aria-label="Results"
          aria-busy={loading}
          style={{ flex: preview.visible ? `${1 - preview.ratio} 1 0` : '1 1 0' }}
          className={cn(
            'rail-scroll min-h-0 overflow-y-auto py-1.5 transition-opacity',
            stale && 'opacity-60',
          )}
        >
          {showSkeleton ? (
            <div className="space-y-2 px-3 py-2">
              {Array.from({ length: 7 }, (_, row) => (
                <Skeleton
                  key={row}
                  className="h-4 rounded"
                  style={{ width: `${45 + ((row * 29) % 45)}%` }}
                />
              ))}
            </div>
          ) : rows.length === 1 && rows[0].kind === 'hint' ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {rows[0].text}
            </div>
          ) : (
            <>
              <div style={{ height: virtual.padTop }} />
              {rows.slice(virtual.start, virtual.end).map((row, offset) => {
                const at = virtual.start + offset;
                const relative = targetOf(row, undefined, undefined)?.relative;
                return (
                  <SearchRow
                    key={row.key}
                    row={row}
                    index={at}
                    id={optionId(at)}
                    active={at === activeIndex}
                    status={
                      relative
                        ? statusByPath.get(prefix ? `${prefix}/${relative}` : relative)
                        : undefined
                    }
                    onHover={select}
                    onOpen={openAt}
                  />
                );
              })}
              <div style={{ height: virtual.padBottom }} />
            </>
          )}
        </div>
        {preview.visible ? (
          <>
            <ResizeHandle
              orientation="horizontal"
              label="Resize the preview"
              size={preview.ratio * bodyHeight}
              min={PREVIEW_MIN * bodyHeight}
              max={PREVIEW_MAX * bodyHeight}
              defaultSize={PREVIEW_DEFAULT * bodyHeight}
              invert
              onSizeChange={(size) => {
                if (bodyHeight > 0) setPreview({ ratio: size / bodyHeight });
              }}
              className={FOOTER_HAIRLINE}
            />
            <div style={{ flex: `${preview.ratio} 1 0` }} className="flex min-h-0 flex-col">
              <SearchPreview target={previewTarget} />
            </div>
          </>
        ) : null}
      </div>

      <SearchFooter
        mode={mode}
        query={query}
        files={fileHits.total}
        types={typeHits.total}
        members={memberHits.total}
        text={text}
        indexTruncated={index.data?.truncated === true}
        symbolsTruncated={symbols.index?.truncated === true}
      />
    </>
  );
}

function SearchFooter({
  mode,
  query,
  files,
  types,
  members,
  text,
  indexTruncated,
  symbolsTruncated,
}: {
  mode: SearchMode;
  query: string;
  files: number;
  types: number;
  members: number;
  text: ReturnType<typeof useTextSearch>;
  indexTruncated: boolean;
  symbolsTruncated: boolean;
}): React.JSX.Element {
  const searchKey = useShortcutLabel('workspace.search');
  let status = '';
  if (query) {
    const textStatus = text.running
      ? 'searching text…'
      : text.summary && !text.summary.error
        ? `${count(text.summary.matches, 'text match', 'text matches')}${text.summary.truncated ? '+' : ''}`
        : '';
    if (mode === 'files') status = count(files, 'file');
    else if (mode === 'types') status = count(types, 'type');
    else if (mode === 'members') status = count(members, 'member');
    else if (mode === 'all') {
      status = [count(files, 'file'), count(types, 'type'), count(members, 'member'), textStatus]
        .filter(Boolean)
        .join(' · ');
    } else if (text.running) status = 'Searching…';
    else if (text.summary && !text.summary.error) {
      const { matches, files: inFiles, truncated } = text.summary;
      status = `${count(matches, 'match', 'matches')} in ${count(inFiles, 'file')}${truncated ? ', showing the first' : ''}`;
    }
    if (mode === 'files' && indexTruncated)
      status += ' · the project is too big to list every file';
    if ((mode === 'types' || mode === 'members') && symbolsTruncated)
      status += ' · some declarations are left out';
  }
  return (
    <div
      className={cn(
        FOOTER_HAIRLINE,
        'flex h-8 shrink-0 items-center gap-3 px-3.5 text-[10.5px] text-muted-foreground',
      )}
    >
      <span>
        <Key>↑↓</Key> move
      </span>
      <span>
        <Key>Enter</Key> open
      </span>
      <span className="hidden sm:inline">
        <Key>Ctrl+Enter</Key> to the side
      </span>
      <span className="hidden md:inline">
        <Key>Tab</Key> next filter
      </span>
      {searchKey ? (
        <span className="hidden lg:inline">
          <Key>{searchKey}</Key> new search
        </span>
      ) : null}
      <span className="ml-auto truncate tabular-nums">{status}</span>
    </div>
  );
}

/** "1 file", "2,000 files". */
function count(value: number, one: string, many = `${one}s`): string {
  return `${value.toLocaleString()} ${value === 1 ? one : many}`;
}

function Key({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="mr-1 rounded-full bg-foreground/[0.07] px-1.5 py-0.5 font-sans text-[10px] font-medium">
      {children}
    </kbd>
  );
}
