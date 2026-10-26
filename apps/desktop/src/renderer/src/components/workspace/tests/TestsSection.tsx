import {
  aggregateStatuses,
  attachResults,
  buildFixTestsPrompt,
  countResults,
  formatTestIssue,
  type Project,
  TEST_FRAMEWORKS,
  type TestNode,
  type TestResult,
  type TestRunError,
  type TestRunSummary,
  type TestStatus,
  type TestTarget,
} from '@runova/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Ban,
  ChevronRight,
  CircleCheck,
  CircleX,
  Copy,
  FileCode,
  Flask,
  Play,
  RefreshCw,
  Spinner,
  StopCircle,
  TriangleAlert,
  Wand2,
} from '@/components/icons';
import {
  Chip,
  Notice,
  SECTION_WELL,
  SEGMENT_TRACK,
  SearchPill,
  segmentClass,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import {
  ensureTestRunSubscription,
  failedCount,
  type ProjectTestRun,
  useTestsStore,
} from '@/stores/testsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { type FixSource, FixWithAiDialog } from '../FixWithAiDialog';
import { PanelNotice } from '../git/PanelNotice';
import { HAIRLINE_BELOW, PanelIconButton } from '../git/PanelTabs';

type Filter = 'all' | 'failed' | 'passed' | 'skipped';

/** A run state chip sized for the panel's summary row. */
const RUN_CHIP = 'h-[18px] px-1.5 text-[10.5px]';

/**
 * Failure output sits in the kit's soft well, tinted red. The well's edge is a ring, so the
 * tint can replace its colour without the global border colour getting in the way.
 */
const FAILURE_WELL = 'bg-destructive/[0.05] ring-destructive/20';

const EMPTY_RUN: ProjectTestRun = { summary: null, results: {}, output: '' };

/** Past this many tests, files start folded so the list stays scannable. */
const FOLD_FILES_OVER = 300;

/** Rows drawn the moment the panel shows. The rest follow in batches React can interrupt. */
const FIRST_ROWS = 80;
const MORE_ROWS = 100;

/**
 * How many rows to draw so far out of `total`. Building every row of a big suite at once held up
 * the click that switched to its project for over a second, so the panel starts with what fills
 * the screen and adds the rest a batch at a time, as transitions a click or a key press can cut in
 * front of.
 */
function useRowsDrawn(total: number): number {
  const [drawn, setDrawn] = useState(FIRST_ROWS);
  useEffect(() => {
    if (drawn >= total) return;
    startTransition(() => setDrawn((current) => current + MORE_ROWS));
  }, [drawn, total]);
  return drawn;
}

/**
 * The run without its output text. Output changes on nearly every event, and only the output pane
 * reads it, so the tree and the buttons must not re-render for it.
 */
function useProjectRun(projectId: string): Omit<ProjectTestRun, 'output'> {
  const summary = useTestsStore((s) => s.runs[projectId]?.summary) ?? EMPTY_RUN.summary;
  const results = useTestsStore((s) => s.runs[projectId]?.results) ?? EMPTY_RUN.results;
  return useMemo(() => ({ summary, results }), [summary, results]);
}

function useHasOutput(projectId: string): boolean {
  return useTestsStore((s) => Boolean(s.runs[projectId]?.output));
}

function OutputPane({ projectId }: { projectId: string }) {
  const output = useTestsStore((s) => s.runs[projectId]?.output ?? '');
  if (!output) return null;
  return (
    <pre
      aria-label="Test output"
      className={cn(
        SECTION_WELL,
        'mx-2 mb-2 max-h-[40%] shrink-0 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground',
      )}
    >
      {output}
    </pre>
  );
}

/**
 * Failed tests, failed files and test projects that could not run in the project's latest run, for
 * the tab badge.
 */
export function useTestsFailedCount(projectId: string): number {
  return useTestsStore((s) => failedCount(s.runs[projectId]));
}

function useDiscovery(projectId: string) {
  return useQuery({
    queryKey: queryKeys.testsDiscovery(projectId),
    queryFn: () => window.runova.tests.discover(projectId),
    staleTime: 30_000,
    meta: { silentLoading: true },
  });
}

async function startRun(projectId: string, targets: TestTarget[]): Promise<void> {
  try {
    await window.runova.tests.run(projectId, targets);
  } catch (error) {
    toast.error('Could not run tests', {
      description:
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(error),
    });
  }
}

function targetFor(node: TestNode): TestTarget {
  if (node.kind === 'project') return { testProjectId: node.testProjectId };
  if (node.kind === 'file') return { testProjectId: node.testProjectId, files: [node.file ?? ''] };
  return { testProjectId: node.testProjectId, tests: [{ file: node.file ?? '', path: node.path }] };
}

/** Groups failed tests into one target per test project. */
function failedTargets(results: TestResult[]): TestTarget[] {
  const byProject = new Map<string, TestTarget>();
  for (const result of results) {
    const target = byProject.get(result.testProjectId) ?? { testProjectId: result.testProjectId };
    if (result.path.length === 0) {
      if (result.file) target.files = [...(target.files ?? []), result.file];
    } else if (result.file) {
      target.tests = [...(target.tests ?? []), { file: result.file, path: result.path }];
    }
    byProject.set(result.testProjectId, target);
  }
  return [...byProject.values()];
}

/**
 * What "Run failed" reruns: the failed tests and files, plus every test project that could not run.
 * A project that never reported results has nothing finer to target, and one that broke part way is
 * rerun whole so its failed tests do not run twice.
 */
function retryTargets(results: TestResult[], errors: TestRunError[]): TestTarget[] {
  const broken = new Set(errors.map((error) => error.testProjectId));
  return [
    ...failedTargets(results.filter((result) => !broken.has(result.testProjectId))),
    ...[...broken].map((testProjectId) => ({ testProjectId })),
  ];
}

function absolutePath(folderPath: string, file: string): string {
  const sep = folderPath.includes('\\') ? '\\' : '/';
  return `${folderPath.replace(/[\\/]+$/, '')}${sep}${file.split('/').join(sep)}`;
}

function openInEditor(project: Project, file: string): void {
  useWorkspaceStore
    .getState()
    .openFile(project.id, absolutePath(project.folderPath, file), { pin: true });
}

const frameworkLabelOf = (testProjectId: string): string | undefined => {
  const framework = testProjectId.split(':')[0] as keyof typeof TEST_FRAMEWORKS;
  return TEST_FRAMEWORKS[framework]?.label;
};

/** Buttons for the Tests tab in the panel's strip. */
export function TestsTabActions({ project }: { project: Project }): React.JSX.Element {
  const queryClient = useQueryClient();
  const run = useProjectRun(project.id);
  const running = run.summary?.running === true;

  useEffect(() => ensureTestRunSubscription(), []);

  return (
    <>
      {running ? (
        <PanelIconButton
          label="Stop tests"
          onClick={() => void window.runova.tests.cancel(project.id)}
        >
          <StopCircle className="h-2.5 w-2.5" />
        </PanelIconButton>
      ) : (
        <PanelIconButton label="Run all tests" onClick={() => void startRun(project.id, [])}>
          <Play className="h-2.5 w-2.5" />
        </PanelIconButton>
      )}
      <PanelIconButton
        label="Refresh tests"
        onClick={() =>
          void queryClient.invalidateQueries({ queryKey: queryKeys.testsDiscovery(project.id) })
        }
      >
        <RefreshCw className="h-2.5 w-2.5" />
      </PanelIconButton>
    </>
  );
}

function StatusIcon({ status }: { status: TestStatus | undefined }): React.JSX.Element {
  if (status === 'running' || status === 'queued') {
    return (
      <span
        role="img"
        aria-label="Running"
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-warning"
      >
        <Spinner className="h-3 w-3 animate-spin" />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span
        role="img"
        aria-label="Failed"
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-destructive"
      >
        <CircleX className="h-3 w-3" />
      </span>
    );
  }
  if (status === 'passed') {
    return (
      <span
        role="img"
        aria-label="Passed"
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-success"
      >
        <CircleCheck className="h-3 w-3" />
      </span>
    );
  }
  if (status === 'skipped') {
    return (
      <span
        role="img"
        aria-label="Skipped"
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground"
      >
        <Ban className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label="Not run"
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
    >
      <span className="h-2 w-2 rounded-full ring-1 ring-inset ring-muted-foreground/40" />
    </span>
  );
}

function RowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label} side="left">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        className="h-5 w-5 opacity-0 focus-visible:opacity-100 group-hover/test:opacity-100 [&_svg]:size-2.5"
      >
        {children}
      </Button>
    </SimpleTooltip>
  );
}

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return formatClock(ms);
}

/** Stopwatch text for how long a run has been going: m:ss, and h:mm:ss once it passes an hour. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * How long the run has been going, ticking once a second. A long suite can take many minutes, and
 * a clock that moves is the clearest sign the run is alive. It stops at the run's own finish time.
 */
function useElapsed(summary: TestRunSummary | null): number | null {
  const startedAt = summary?.startedAt;
  // A run that is over always stops the clock, even if it never reported a finish time.
  const finishedAt =
    summary && !summary.running ? (summary.finishedAt ?? summary.startedAt) : undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === undefined || finishedAt !== undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt, finishedAt]);

  if (startedAt === undefined) return null;
  return Math.max(0, (finishedAt ?? now) - startedAt);
}

/** The run's stopwatch, on its own so its tick every second redraws only itself, not the tree. */
function ElapsedClock({ summary }: { summary: TestRunSummary }): React.JSX.Element | null {
  const elapsed = useElapsed(summary);
  if (elapsed === null) return null;
  return (
    <span aria-label="Elapsed time" className="text-muted-foreground tabular-nums">
      {summary.running ? formatClock(elapsed) : formatDuration(elapsed)}
    </span>
  );
}

interface VisibleRow {
  node: TestNode;
  depth: number;
}

function nodeMatches(node: TestNode, query: string): boolean {
  return node.name.toLowerCase().includes(query);
}

/** The rows to draw, in order, after folding, the status filter and the search are applied. */
function visibleRows(
  tree: TestNode[],
  statuses: Map<string, TestStatus>,
  own: Record<string, TestResult>,
  filter: Filter,
  query: string,
  collapsed: Set<string>,
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const passesFilter = (node: TestNode): boolean => {
    if (filter === 'all') return true;
    const status =
      own[node.id]?.status ?? (node.kind === 'test' ? statuses.get(node.id) : undefined);
    if (status === filter) return node.kind === 'test' || own[node.id] !== undefined;
    return node.children.some(passesFilter);
  };
  const passesSearch = (node: TestNode): boolean =>
    !query || nodeMatches(node, query) || node.children.some(passesSearch);

  const visit = (node: TestNode, depth: number, ancestorMatched: boolean): void => {
    const matched = ancestorMatched || !query || nodeMatches(node, query);
    if (!passesFilter(node)) return;
    if (!matched && !passesSearch(node)) return;
    rows.push({ node, depth });
    if (collapsed.has(node.id) && !query && filter === 'all') return;
    for (const child of node.children) visit(child, depth + 1, matched && Boolean(query));
  };
  for (const project of tree) visit(project, 0, false);
  return rows;
}

interface RowActions {
  toggleCollapsed: (id: string) => void;
  toggleDetails: (id: string) => void;
  open: (file: string) => void;
  run: (node: TestNode) => void;
  fix: (result: TestResult) => void;
  copy: (result: TestResult) => void;
}

/**
 * One line of the tree. Results arrive in batches several times a second during a run, and a big
 * suite has thousands of rows, so a row only redraws when its own node, status or result changed.
 */
const TestRow = memo(function TestRow({
  node,
  depth,
  status,
  own,
  isCollapsed,
  detailsHidden,
  running,
  actions,
}: {
  node: TestNode;
  depth: number;
  status: TestStatus | undefined;
  own: TestResult | undefined;
  isCollapsed: boolean;
  detailsHidden: boolean;
  running: boolean;
  actions: RowActions;
}): React.JSX.Element {
  const hasChildren = node.children.length > 0;
  const failure = own?.status === 'failed' && (own.message || own.stack) ? own : null;
  const detailsOpen = failure !== null && !detailsHidden;
  const duration = node.kind === 'test' ? formatDuration(own?.durationMs) : null;
  const indent = 8 + depth * 12;
  return (
    <div>
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        aria-selected={false}
        tabIndex={-1}
        onClick={() => {
          if (failure) actions.toggleDetails(node.id);
          else if (hasChildren) actions.toggleCollapsed(node.id);
        }}
        onDoubleClick={() => node.file && actions.open(node.file)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && hasChildren) actions.toggleCollapsed(node.id);
        }}
        style={{ paddingLeft: indent }}
        className={cn(
          'group/test mx-1.5 flex h-6 cursor-default select-none items-center gap-1.5 rounded-lg pr-1 transition-colors',
          status === 'failed' && node.kind === 'test'
            ? 'bg-destructive/[0.05] hover:bg-destructive/[0.08]'
            : 'hover:bg-foreground/[0.06]',
        )}
      >
        <span className="flex h-3 w-3 shrink-0 items-center justify-center text-muted-foreground">
          {hasChildren ? (
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              onClick={(event) => {
                event.stopPropagation();
                actions.toggleCollapsed(node.id);
              }}
              className="flex h-3 w-3 items-center justify-center"
            >
              <ChevronRight
                className={cn('h-2 w-2 transition-transform', !isCollapsed && 'rotate-90')}
              />
            </button>
          ) : null}
        </span>
        <StatusIcon status={status} />
        {node.kind === 'file' ? (
          <FileCode className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
        ) : null}
        <span
          data-test-name
          className={cn(
            'min-w-0 flex-1 truncate',
            node.kind === 'project'
              ? 'text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground'
              : 'text-[12px]',
            node.kind === 'suite' && 'text-foreground/80',
          )}
        >
          {node.name}
        </span>
        {duration ? (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {duration}
          </span>
        ) : null}
        <span className="flex shrink-0 items-center">
          {node.file ? (
            <RowButton label={`Open ${node.name}`} onClick={() => actions.open(node.file ?? '')}>
              <FileCode className="h-2.5 w-2.5" />
            </RowButton>
          ) : null}
          {!running ? (
            <RowButton label={`Run ${node.name}`} onClick={() => actions.run(node)}>
              <Play className="h-2.5 w-2.5" />
            </RowButton>
          ) : null}
        </span>
      </div>
      {node.kind === 'project' && node.children.length === 0 ? (
        <p className="py-1 text-[11px] text-muted-foreground" style={{ paddingLeft: indent + 36 }}>
          No tests found in this project.
        </p>
      ) : null}
      {failure && detailsOpen ? (
        <FailureDetail
          result={failure}
          indent={indent + 18}
          onFix={() => actions.fix(failure)}
          onCopy={() => actions.copy(failure)}
          onOpen={failure.file ? () => actions.open(failure.file ?? '') : undefined}
        />
      ) : null}
    </div>
  );
});

/** The project's tests: discover, run, follow results, and act on failures. */
export function TestsSection({ project }: { project: Project }): React.JSX.Element {
  const discovery = useDiscovery(project.id);
  const run = useProjectRun(project.id);
  const hasOutput = useHasOutput(project.id);
  const hydrate = useTestsStore((s) => s.hydrate);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hiddenDetails, setHiddenDetails] = useState<Set<string>>(new Set());
  const [showOutput, setShowOutput] = useState(false);
  const [fixing, setFixing] = useState<{
    title: string;
    description?: string;
    jobKey: string;
    source: FixSource;
  } | null>(null);

  useEffect(() => ensureTestRunSubscription(), []);

  useEffect(() => {
    let cancelled = false;
    void window.runova.tests
      .lastRun(project.id)
      .then((snapshot) => {
        if (!cancelled && snapshot) hydrate(project.id, snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [project.id, hydrate]);

  const results = useMemo(() => Object.values(run.results), [run.results]);
  const tree = useMemo(
    () => (discovery.data ? attachResults(discovery.data.tree, results) : []),
    [discovery.data, results],
  );
  const statuses = useMemo(() => aggregateStatuses(tree, results), [tree, results]);
  const trimmedQuery = query.trim().toLowerCase();
  const rows = useMemo(
    () => visibleRows(tree, statuses, run.results, filter, trimmedQuery, collapsed),
    [tree, statuses, run.results, filter, trimmedQuery, collapsed],
  );
  const drawn = useRowsDrawn(rows.length);

  // Rows are memoized, so they get one set of handlers for good; each call goes to the latest
  // render's version of it, which knows the current run and discovery.
  const latestActions = useRef<RowActions | null>(null);
  const rowActions = useMemo<RowActions>(
    () => ({
      toggleCollapsed: (id) => latestActions.current?.toggleCollapsed(id),
      toggleDetails: (id) => latestActions.current?.toggleDetails(id),
      open: (file) => latestActions.current?.open(file),
      run: (node) => latestActions.current?.run(node),
      fix: (result) => latestActions.current?.fix(result),
      copy: (result) => latestActions.current?.copy(result),
    }),
    [],
  );

  // Big suites start with files folded; the choice is made once per discovery.
  useEffect(() => {
    if (!discovery.data) return;
    let tests = 0;
    const files: string[] = [];
    const count = (node: TestNode): void => {
      if (node.kind === 'test') tests += 1;
      if (node.kind === 'file') files.push(node.id);
      node.children.forEach(count);
    };
    discovery.data.tree.forEach(count);
    setCollapsed(tests > FOLD_FILES_OVER ? new Set(files) : new Set());
  }, [discovery.data]);

  if (discovery.isPending) {
    return (
      <div aria-label="Finding tests" aria-busy="true" className="space-y-1 px-2 py-1.5">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton
            key={i}
            className="h-6 rounded-lg"
            style={{ marginLeft: `${(i % 3) * 12}px`, width: `${92 - (i % 3) * 10}%` }}
          />
        ))}
      </div>
    );
  }

  const notice = (
    title: string,
    body: React.ReactNode,
    action?: { label: string; run: () => void },
  ) => <PanelNotice icon={Flask} title={title} body={body} action={action} />;

  if (discovery.isError) {
    return notice('Could not read the tests', discovery.error.message, {
      label: 'Try again',
      run: () => void discovery.refetch(),
    });
  }
  if (discovery.data.projects.length === 0) {
    return notice(
      'No tests found',
      'Runova looks for Vitest, Jest, Playwright, Mocha, pytest, unittest, Go, Cargo, .NET, Dart, Flutter, PHPUnit, RSpec, Gradle and Maven projects.',
      { label: 'Look again', run: () => void discovery.refetch() },
    );
  }

  const summary = run.summary;
  const running = summary?.running === true;
  const runErrors = summary?.errors ?? [];
  const counts = countResults(results);
  // A test project that could not run shows as a card and counts as a failure next to failed tests.
  counts.failed += runErrors.length;
  // Queued tests have no result of their own yet, so count them straight from the run.
  const inFlight = results.filter(
    (result) => result.status === 'queued' || result.status === 'running',
  ).length;
  const failures = results.filter((result) => result.status === 'failed');
  const failedTests = failures.filter((result) => result.path.length > 0);
  // "Run failed" covers everything the failed chip counts, including projects that could not run.
  // A missing runner gets no fix button on its card, so "Fix all" leaves it out too.
  const fixableErrors = runErrors.filter((error) => error.kind !== 'notFound');
  const labelOf = (testProjectId: string): string =>
    discovery.data.projects.find((entry) => entry.id === testProjectId)?.label ?? testProjectId;
  const toggle = (id: string, set: React.Dispatch<React.SetStateAction<Set<string>>>): void =>
    set((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function copyIssue(result: TestResult): Promise<void> {
    const command = result.file
      ? await window.runova.tests
          .command(project.id, {
            testProjectId: result.testProjectId,
            ...(result.path.length > 0
              ? { tests: [{ file: result.file, path: result.path }] }
              : { files: [result.file] }),
          })
          .catch(() => null)
      : null;
    const issue = formatTestIssue(result, {
      frameworkLabel: frameworkLabelOf(result.testProjectId),
      command: command ?? undefined,
    });
    try {
      await navigator.clipboard.writeText(issue);
      toast.success('Issue copied');
    } catch (error) {
      // The browser clipboard only works while the window has focus; say so rather than go quiet.
      toast.error('Could not copy the issue', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Opens the dialog straight away and fills the prompt once the rerun command is known. */
  function fixResults(list: TestResult[], errors: TestRunError[]): void {
    const projectIds = [
      ...new Set([
        ...list.map((entry) => entry.testProjectId),
        ...errors.map((entry) => entry.testProjectId),
      ]),
    ];
    const single = projectIds.length === 1 ? projectIds[0] : undefined;
    const frameworkLabel = single ? frameworkLabelOf(single) : undefined;
    const title =
      errors.length === 0 && list.length === 1
        ? `Fix ${list[0].path.join(' > ') || list[0].file} with AI`
        : errors.length === 0
          ? `Fix ${list.length} failing tests with AI`
          : list.length === 0 && errors.length === 1
            ? `Fix the ${single ? labelOf(single) : ''} test run with AI`.replace('  ', ' ')
            : `Fix ${list.length + errors.length} failures with AI`;
    const jobKey = `tests-fix:${project.id}:${summary?.runId ?? 'none'}:${[...list.map((entry) => entry.id), ...errors.map((entry) => entry.testProjectId)].join('|')}`;
    const build = (command?: string) =>
      buildFixTestsPrompt({ failures: list, errors, frameworkLabel, command });
    const description = [projectIds.map(labelOf).join(', '), list[0]?.file]
      .filter(Boolean)
      .join(' · ');
    setFixing({
      title,
      description,
      jobKey,
      source: { prompt: null, loadingLabel: 'Collecting the failure output…' },
    });

    const target = single && list.length > 0 ? failedTargets(list)[0] : undefined;
    // A run that could not finish carries its own command in the prompt, and one command cannot
    // stand for several projects, so only a single project's failed tests get a rerun command.
    const commandPromise = target
      ? window.runova.tests.command(project.id, target).catch(() => null)
      : Promise.resolve(null);
    void commandPromise.then((command) =>
      setFixing((current) =>
        current && current.jobKey === jobKey
          ? { ...current, source: { prompt: build(command ?? undefined) } }
          : current,
      ),
    );
  }

  latestActions.current = {
    toggleCollapsed: (id) => toggle(id, setCollapsed),
    toggleDetails: (id) => toggle(id, setHiddenDetails),
    open: (file) => openInEditor(project, file),
    run: (node) => void startRun(project.id, [targetFor(node)]),
    fix: (result) => fixResults([result], []),
    copy: (result) => void copyIssue(result),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {summary ? (
        <div className={cn('shrink-0 px-2.5 py-2', HAIRLINE_BELOW)}>
          {/* Counts first, buttons under them: the panel is narrow and one row makes both wrap.
              Each state is a tinted chip, the way run states read on the Pipelines page. */}
          <div
            role="group"
            aria-label="Test run counts"
            className="flex flex-wrap items-center gap-1 text-[11px]"
          >
            {running ? (
              <Chip tone="warning" dot pulse className={RUN_CHIP}>
                {inFlight > 0
                  ? `Running ${inFlight} ${inFlight === 1 ? 'test' : 'tests'}…`
                  : 'Running tests…'}
              </Chip>
            ) : null}
            {/* The counts stay up during the run so results can be watched arriving. */}
            {counts.failed > 0 ? (
              <Chip tone="destructive" className={cn(RUN_CHIP, 'font-semibold')}>
                {counts.failed} failed
              </Chip>
            ) : null}
            {counts.passed > 0 ? (
              <Chip tone="success" className={RUN_CHIP}>
                {counts.passed} passed
              </Chip>
            ) : null}
            {counts.skipped > 0 ? <Chip className={RUN_CHIP}>{counts.skipped} skipped</Chip> : null}
            {!running && summary.cancelled ? <Chip className={RUN_CHIP}>Stopped</Chip> : null}
            <span className="ml-auto pl-1 text-[11px]">
              <ElapsedClock summary={summary} />
            </span>
          </div>
          {!running && (counts.failed > 0 || hasOutput) ? (
            <div
              role="group"
              aria-label="Test run actions"
              className="mt-1.5 flex flex-wrap items-center gap-1"
            >
              {counts.failed > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label="Run failed tests"
                  onClick={() => void startRun(project.id, retryTargets(failures, runErrors))}
                  className="shrink-0 text-muted-foreground"
                >
                  <Play />
                  Run failed
                </Button>
              ) : null}
              {failedTests.length + fixableErrors.length > 1 ? (
                <Button
                  type="button"
                  variant="tint"
                  size="xs"
                  aria-label="Fix all failures with AI"
                  onClick={() => fixResults(failedTests, fixableErrors)}
                  className="shrink-0"
                >
                  <Wand2 />
                  Fix all with AI
                </Button>
              ) : null}
              {hasOutput ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={showOutput ? 'Hide output' : 'Show output'}
                  aria-pressed={showOutput}
                  onClick={() => setShowOutput((value) => !value)}
                  className={cn(
                    'shrink-0 text-muted-foreground',
                    showOutput &&
                      'bg-primary/12 text-primary hover:bg-primary/20 hover:text-primary',
                  )}
                >
                  Output
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        className={cn('flex shrink-0 flex-wrap items-center gap-1.5 px-2 py-1.5', HAIRLINE_BELOW)}
      >
        <SearchPill
          type="search"
          label="Filter tests"
          clearLabel="Clear filter"
          placeholder="Filter tests"
          value={query}
          onValueChange={setQuery}
          className="h-7 min-w-[7rem] flex-1 pl-2.5"
          inputClassName="text-[12px]"
        />
        <div role="radiogroup" aria-label="Show" className={cn(SEGMENT_TRACK, 'shrink-0 gap-0.5')}>
          {(['all', 'failed', 'passed', 'skipped'] as const).map((value) => {
            const label = value === 'all' ? 'All' : value[0].toUpperCase() + value.slice(1);
            const count = value === 'all' ? null : counts[value];
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={filter === value}
                onClick={() => setFilter(value)}
                className={cn(segmentClass(filter === value), 'gap-1 px-2 text-[10px]')}
              >
                {label}
                {count ? <span className="tabular-nums opacity-70">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {/* They count as failed, so the Passed and Skipped filters leave them out. */}
        {filter === 'all' || filter === 'failed'
          ? runErrors.map((error) => (
              <RunErrorCard
                key={`${error.testProjectId}:${error.kind}`}
                error={error}
                label={labelOf(error.testProjectId)}
                onFix={() => fixResults([], [error])}
              />
            ))
          : null}
        {discovery.data.truncated ? (
          <Notice tone="warning" size="sm" className="mx-2 mb-1 text-[11px] leading-snug">
            This project has more test files than the panel reads, so some are not listed.
          </Notice>
        ) : null}
        <div role="tree" aria-label="Tests" className="space-y-px">
          {rows.slice(0, drawn).map(({ node, depth }) => (
            <TestRow
              key={node.id}
              node={node}
              depth={depth}
              status={statuses.get(node.id)}
              own={run.results[node.id]}
              isCollapsed={collapsed.has(node.id)}
              detailsHidden={hiddenDetails.has(node.id)}
              running={running}
              actions={rowActions}
            />
          ))}
        </div>
      </div>

      {showOutput ? <OutputPane projectId={project.id} /> : null}

      {fixing ? (
        <FixWithAiDialog
          project={project}
          open
          onOpenChange={(open) => {
            if (!open) setFixing(null);
          }}
          title={fixing.title}
          description={fixing.description}
          jobKey={fixing.jobKey}
          source={fixing.source}
        />
      ) : null}
    </div>
  );
}

function FailureDetail({
  result,
  indent,
  onFix,
  onCopy,
  onOpen,
}: {
  result: TestResult;
  indent: number;
  onFix: () => void;
  onCopy: () => void;
  onOpen?: () => void;
}): React.JSX.Element {
  const [showStack, setShowStack] = useState(false);
  const name = result.path.length > 0 ? result.path.join(' > ') : (result.file ?? 'file');
  return (
    <div
      role="group"
      aria-label={`${name} failure`}
      style={{ marginLeft: indent }}
      className={cn(SECTION_WELL, FAILURE_WELL, 'mb-1.5 mr-2 mt-1 p-2.5')}
    >
      {result.message ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-destructive">
          {result.message}
        </pre>
      ) : null}
      {result.stack ? (
        <>
          <button
            type="button"
            onClick={() => setShowStack((value) => !value)}
            className="mt-1 cursor-pointer rounded-full text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {showStack ? 'Hide stack' : 'Show stack'}
          </button>
          {showStack ? (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre font-mono text-[10px] leading-relaxed text-muted-foreground">
              {result.stack}
            </pre>
          ) : null}
        </>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Button type="button" variant="tint" size="xs" onClick={onFix}>
          <Wand2 />
          Fix with AI
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onCopy}
          className="text-muted-foreground"
        >
          <Copy />
          Copy issue
        </Button>
        {onOpen ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onOpen}
            className="text-muted-foreground"
          >
            <FileCode />
            Open file
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function RunErrorCard({
  error,
  label,
  onFix,
}: {
  error: TestRunError;
  label: string;
  onFix: () => void;
}): React.JSX.Element {
  const log = error.log.trim();
  return (
    <div
      role="group"
      aria-label={`${label} could not run`}
      className={cn(SECTION_WELL, FAILURE_WELL, 'mx-2 mb-1.5 p-2.5')}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-destructive">
        <TriangleAlert className="h-3 w-3" />
        {label} could not run
      </p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-foreground/80">{error.message}</p>
      {log ? (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
          {log.slice(-4_000)}
        </pre>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1">
        {error.kind !== 'notFound' ? (
          <Button type="button" variant="tint" size="xs" onClick={onFix}>
            <Wand2 />
            Fix with AI
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            void navigator.clipboard.writeText(
              `$ ${error.command}\n\n${error.message}\n\n${log}`.trim(),
            );
            toast.success('Output copied');
          }}
          className="text-muted-foreground"
        >
          <Copy />
          Copy output
        </Button>
      </div>
    </div>
  );
}
