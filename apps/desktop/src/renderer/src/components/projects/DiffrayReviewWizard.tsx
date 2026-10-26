import type { AgentType, Project } from '@runova/core';
import {
  allDiffrayAgentIds,
  allDiffraySeverities,
  buildDiffrayCodebaseScript,
  buildDiffrayProjectConfig,
  chunkDiffrayFiles,
  DIFFRAY_AGENTS,
  DIFFRAY_DEFAULT_FILES_PER_PASS,
  DIFFRAY_DEFAULT_JSON_FILE,
  DIFFRAY_EXECUTORS,
  DIFFRAY_GITHUB_APP_URL,
  DIFFRAY_MAX_FILES_PER_PASS,
  DIFFRAY_MODEL_TRADEOFFS,
  DIFFRAY_MODELS,
  DIFFRAY_PROJECT_CONFIG_FILE,
  type DiffrayExecutorId,
  type DiffrayReviewScope,
  type DiffrayShellKind,
  defaultDiffrayExecutorForAgentType,
  diffrayCodebaseFolders,
  filterDiffrayCodebaseFiles,
  joinDiffrayCommands,
  planDiffrayReview,
} from '@runova/core';
import type { GitStatus } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CliLogo, cliOptionIcon } from '@/components/cliLogos';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bolt,
  Bug,
  Check,
  CircleInfo,
  CircleX,
  Clock,
  Code,
  Copy,
  Cpu,
  ExternalLink,
  File,
  FileCog,
  FolderTree,
  GitBranch,
  GitCommit,
  Github,
  GitPullRequest,
  Play,
  Robot,
  Shield,
  Spinner,
  TriangleAlert,
  Wrench,
} from '@/components/icons';
import { SectionEmptyState } from '@/components/projects/ProjectDetailChrome';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useTerminalStore } from '@/stores/terminalStore';

type WizardStep = 'diff' | 'agents' | 'engine' | 'launch';

const STEPS: { id: WizardStep; label: string; hint: string; icon: typeof Code }[] = [
  { id: 'diff', label: 'Diffs', hint: 'What to scan', icon: GitPullRequest },
  { id: 'agents', label: 'Agents', hint: 'Who looks', icon: Robot },
  { id: 'engine', label: 'Engine', hint: 'Which AI', icon: Cpu },
  { id: 'launch', label: 'Launch', hint: 'Run the review', icon: Play },
];

const AGENT_ICON = {
  general: Code,
  'bug-hunter': Bug,
  'security-scan': Shield,
  'performance-check': Bolt,
  'consistency-check': Copy,
} as const;

/** diffray executor ids don't match the CLI ids the brand logos are keyed by. */
const EXECUTOR_LOGO_ID: Record<DiffrayExecutorId, string> = {
  'claude-cli': 'claude-code',
  'cursor-agent-cli': 'cursor-cli',
  'opencode-cli': 'opencode',
  'codex-cli': 'codex-cli',
};

const SEVERITY_ICON = {
  critical: CircleX,
  high: TriangleAlert,
  medium: CircleInfo,
  low: ArrowDown,
} as const;

const AGENT_GUTTER: Record<string, string> = {
  general: 'border-l-primary',
  'bug-hunter': 'border-l-destructive',
  'security-scan': 'border-l-warning',
  'performance-check': 'border-l-primary/70',
  'consistency-check': 'border-l-foreground/40',
};

/** Combobox values cannot be empty, so the whole-repo choice gets a sentinel. */
const ROOT_FOLDER_VALUE = '__root';

/** Commit counts people actually ask for, one click away from the number field. */
const COMMIT_PRESETS = [1, 3, 5, 10];

/** How many files of the preview list get rendered before it turns into a count. */
const FILE_PREVIEW_LIMIT = 200;

function terminalShell(): DiffrayShellKind {
  return window.runova.platform === 'win32' ? 'powershell' : 'posix';
}

function defaultScope(status: GitStatus | undefined): DiffrayReviewScope {
  if (!status?.isRepo) return 'working-tree';
  if (status.files.length > 0) return 'working-tree';
  if (status.defaultBranch && status.branch && status.branch !== status.defaultBranch) {
    return 'base-branch';
  }
  return 'working-tree';
}

export function DiffrayReviewLaunchCard({
  installed,
  onOpen,
}: {
  installed: boolean;
  onOpen: () => void;
}): React.JSX.Element | null {
  if (!installed) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      // A ring for the hover edge: the glass card's own border is unlayered CSS and would win.
      className="glass group relative w-full overflow-hidden rounded-[calc(var(--radius)+2px)] p-4 text-left transition-shadow hover:ring-1 hover:ring-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <GitPullRequest className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">Review with diffray</span>
            <span className="inline-flex h-5 items-center rounded-full bg-primary/12 px-2 text-[11px] font-medium text-primary">
              Multi-agent
            </span>
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Run specialized agents over this project's git changes or its whole source tree, then
            read the report in the terminal or save it as JSON.
          </span>
        </span>
        <ArrowRight className="mt-2 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
      </span>
    </button>
  );
}

export function DiffrayReviewWizardDialog({
  open,
  onOpenChange,
  project,
  installed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  installed: boolean;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Review {project.name} with diffray</DialogTitle>
        <DialogDescription className="sr-only">
          Choose a diff, pick review agents, then run diffray in this project's terminal.
        </DialogDescription>
        {open && (
          <DiffrayReviewWizard
            key={project.id}
            projectId={project.id}
            projectName={project.name}
            folderPath={project.folderPath}
            agentType={project.agentType}
            installed={installed}
            compact
            onLaunched={() => onOpenChange(false)}
            onDismiss={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DiffrayReviewWizard({
  projectId,
  projectName,
  folderPath,
  agentType,
  installed,
  compact = false,
  onLaunched,
  onDismiss,
}: {
  projectId: string;
  projectName: string;
  folderPath: string;
  agentType: AgentType;
  installed: boolean;
  compact?: boolean;
  onLaunched?: () => void;
  onDismiss?: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const openSession = useTerminalStore((s) => s.openSession);

  const [step, setStep] = useState<WizardStep>('diff');
  const [scope, setScope] = useState<DiffrayReviewScope>('working-tree');
  const [baseRef, setBaseRef] = useState('');
  const [commitCount, setCommitCount] = useState(3);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [fullFiles, setFullFiles] = useState(false);
  const [codebaseFolder, setCodebaseFolder] = useState('');
  const [includeTests, setIncludeTests] = useState(false);
  const [filesPerPass, setFilesPerPass] = useState(DIFFRAY_DEFAULT_FILES_PER_PASS);
  const [skippedFiles, setSkippedFiles] = useState<Set<string>>(new Set());
  const [jsonOutput, setJsonOutput] = useState(false);
  const [jsonFileName, setJsonFileName] = useState(DIFFRAY_DEFAULT_JSON_FILE);
  const [agentIds, setAgentIds] = useState<Set<string>>(() => new Set(allDiffrayAgentIds()));
  const [executor, setExecutor] = useState<DiffrayExecutorId>(() =>
    defaultDiffrayExecutorForAgentType(agentType),
  );
  const [model, setModel] = useState('');
  const [showTradeoffs, setShowTradeoffs] = useState(false);
  const [severities, setSeverities] = useState<Set<string>>(() => new Set(allDiffraySeverities()));
  const [skipValidation, setSkipValidation] = useState(false);
  const [stream, setStream] = useState(true);
  const [writeConfig, setWriteConfig] = useState(false);
  const [hasConfig, setHasConfig] = useState<boolean | null>(null);
  const gitDefaultsApplied = useRef(false);

  const gitQuery = useQuery({
    queryKey: queryKeys.gitStatus(projectId),
    queryFn: () => window.runova.git.status(projectId),
    enabled: installed,
  });

  // Only the codebase scope needs the full file list, so it is not fetched until asked for.
  const repoFilesQuery = useQuery({
    queryKey: queryKeys.gitFiles(projectId),
    queryFn: () => window.runova.git.listFiles(projectId),
    enabled: installed && scope === 'codebase',
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!installed) return;
    let cancelled = false;
    void window.runova.fs
      .readFile(`${folderPath}/${DIFFRAY_PROJECT_CONFIG_FILE}`)
      .then(() => {
        if (!cancelled) setHasConfig(true);
      })
      .catch(() => {
        if (!cancelled) setHasConfig(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folderPath, installed]);

  useEffect(() => {
    const gitStatus = gitQuery.data;
    if (!gitStatus?.isRepo || gitDefaultsApplied.current) return;
    gitDefaultsApplied.current = true;
    setScope(defaultScope(gitStatus));
    if (gitStatus.defaultBranch) setBaseRef(gitStatus.defaultBranch);
    else if (gitStatus.branch) setBaseRef(gitStatus.branch);
    setSelectedFiles(new Set(gitStatus.files.map((file) => file.path)));
  }, [gitQuery.data]);

  const models = DIFFRAY_MODELS[executor] ?? [{ value: '', label: 'Executor default' }];
  const stepIndex = STEPS.findIndex((entry) => entry.id === step);
  const status = gitQuery.data;
  const changedFiles = status?.files ?? [];
  const branchOptions = useMemo(() => {
    const names = new Set<string>();
    for (const branch of status?.branches ?? []) {
      if (branch.local || branch.remote) names.add(branch.name);
    }
    if (status?.defaultBranch) names.add(status.defaultBranch);
    if (status?.branch) names.add(status.branch);
    return [...names].sort().map((name) => ({
      value: name,
      label: name,
      icon: <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
    }));
  }, [status]);

  const modelOptions = useMemo(
    () =>
      models.map((entry) => ({
        value: entry.value || '__default',
        label: entry.label,
        icon: cliOptionIcon(EXECUTOR_LOGO_ID[executor]),
      })),
    [executor, models],
  );

  const repoFiles = repoFilesQuery.data;
  const codebaseFiles = useMemo(
    () => filterDiffrayCodebaseFiles(repoFiles ?? [], { folder: codebaseFolder, includeTests }),
    [codebaseFolder, includeTests, repoFiles],
  );
  const reviewedCodebaseFiles = useMemo(
    () => codebaseFiles.filter((file) => !skippedFiles.has(file)),
    [codebaseFiles, skippedFiles],
  );
  const folderOptions = useMemo(() => {
    const all = filterDiffrayCodebaseFiles(repoFiles ?? [], { includeTests });
    return [
      {
        value: ROOT_FOLDER_VALUE,
        label: `Whole repository (${all.length} file${all.length === 1 ? '' : 's'})`,
        icon: <FolderTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
      },
      ...diffrayCodebaseFolders(repoFiles ?? [], { includeTests }).map((folder) => ({
        value: folder.path,
        label: `${folder.path} (${folder.fileCount})`,
        icon: <FolderTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
      })),
    ];
  }, [includeTests, repoFiles]);

  const passes = useMemo(
    () =>
      scope === 'codebase' ? chunkDiffrayFiles(reviewedCodebaseFiles, filesPerPass).length : 1,
    [filesPerPass, reviewedCodebaseFiles, scope],
  );

  const reviewInput = useMemo(
    () => ({
      scope,
      baseRef,
      commitCount,
      files: scope === 'codebase' ? reviewedCodebaseFiles : [...selectedFiles],
      fullFiles,
      filesPerPass,
      agentIds: [...agentIds],
      executor,
      model,
      severities: [...severities],
      skipValidation,
      stream,
      jsonOutput,
    }),
    [
      agentIds,
      baseRef,
      commitCount,
      executor,
      filesPerPass,
      fullFiles,
      jsonOutput,
      model,
      reviewedCodebaseFiles,
      scope,
      selectedFiles,
      severities,
      skipValidation,
      stream,
    ],
  );

  const { commands, reportFiles } = useMemo(
    () => planDiffrayReview(reviewInput, { shell: terminalShell(), jsonFileName }),
    [jsonFileName, reviewInput],
  );

  /**
   * A whole-codebase review is dozens of passes, and chaining those onto the prompt means a line
   * thousands of characters long that no shell handles well. That run goes through a script
   * instead, which resolves the file list itself when it runs.
   */
  const codebaseScript = useMemo(
    () =>
      scope === 'codebase'
        ? buildDiffrayCodebaseScript(reviewInput, {
            shell: terminalShell(),
            label: projectName,
            scriptId: projectId,
            jsonFileName,
            folder: codebaseFolder,
            includeTests,
            skipFiles: [...skippedFiles],
          })
        : null,
    [
      codebaseFolder,
      includeTests,
      jsonFileName,
      projectId,
      projectName,
      reviewInput,
      scope,
      skippedFiles,
    ],
  );

  const canContinue =
    (step === 'diff' &&
      (scope === 'working-tree' ||
        (scope === 'base-branch' && Boolean(baseRef.trim())) ||
        (scope === 'last-commits' && commitCount >= 1) ||
        (scope === 'files' && selectedFiles.size > 0) ||
        (scope === 'codebase' && reviewedCodebaseFiles.length > 0))) ||
    (step === 'agents' && agentIds.size > 0) ||
    (step === 'engine' && Boolean(executor)) ||
    (step === 'launch' && commands.length > 0);

  function goNext(): void {
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next.id);
  }

  function goBack(): void {
    const prev = STEPS[stepIndex - 1];
    if (prev) setStep(prev.id);
  }

  function toggleAgent(id: string): void {
    setAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSeverity(id: string): void {
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleFile(path: string): void {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleSkippedFile(path: string): void {
    setSkippedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handleLaunch(): Promise<void> {
    if (commands.length === 0) return;
    if (writeConfig) {
      const action = buildDiffrayProjectConfig({
        executor,
        excludeTests: true,
      });
      if (action.kind === 'write-project-file') {
        await window.runova.fs.writeFile(`${folderPath}/${action.relativePath}`, action.content);
        setHasConfig(true);
        toast.success(`${DIFFRAY_PROJECT_CONFIG_FILE} written to ${projectName}.`);
      }
    }
    let initialInput = joinDiffrayCommands(commands);
    if (codebaseScript) {
      const scriptPath = await window.runova.fs.writeScratchFile(
        codebaseScript.fileName,
        codebaseScript.content,
      );
      initialInput = codebaseScript.commandFor(scriptPath);
    }
    openSession({
      title: `diffray · ${projectName}`,
      initialInput,
      cwd: folderPath,
      projectId,
    });
    toast.info(
      codebaseScript
        ? `${commands.length} passes ready to run. Press Enter in the terminal to start.`
        : 'Press Enter in the terminal to start the review.',
    );
    onLaunched?.();
  }

  function goToTools(): void {
    onDismiss?.();
    navigate('/tools');
  }

  function goToGit(): void {
    onDismiss?.();
    navigate(`/projects/${projectId}?tab=git`);
  }

  if (!installed) {
    return (
      <div className={compact ? 'p-6 pr-12' : undefined}>
        <SectionEmptyState
          inset={compact}
          icon={GitPullRequest}
          title="diffray is not installed yet"
          description="Install the CLI from Agent Tools, then come back here to review this project's changes with specialized agents."
          action={
            <Button onClick={goToTools}>
              <Wrench /> Open Agent Tools
            </Button>
          }
        />
      </div>
    );
  }

  if (gitQuery.isPending) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 text-sm text-muted-foreground',
          compact ? 'px-6 py-10 pr-12' : 'glass rounded-[calc(var(--radius)+2px)] px-4 py-10',
        )}
      >
        <Spinner className="h-4 w-4 animate-spin" /> Reading git status…
      </div>
    );
  }

  if (!status?.isRepo) {
    return (
      <div className={compact ? 'p-6 pr-12' : undefined}>
        <SectionEmptyState
          inset={compact}
          icon={GitBranch}
          title="This folder is not a git repository"
          description="diffray reviews git diffs. Initialize a repository on the Git tab first."
          action={
            <Button onClick={goToGit}>
              <GitBranch /> Open Git
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative flex flex-col overflow-hidden',
        compact ? 'min-h-0 flex-1' : 'glass rounded-[calc(var(--radius)+2px)]',
      )}
    >
      <div className="absolute inset-y-0 left-0 w-1 overflow-hidden" aria-hidden>
        <div className="h-1/2 bg-primary" />
        <div className="h-1/2 bg-destructive/70" />
      </div>

      <div
        className={cn(
          'shrink-0 space-y-4 pb-4 pl-6 pr-5 pt-5',
          compact && 'border-b border-border/70',
        )}
      >
        <header className="space-y-1 pr-8">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Multi-agent review
          </p>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            Review this change set
          </h2>
          <p className="text-sm text-muted-foreground">
            {status.branch ? (
              <>
                Scanning <span className="font-mono text-foreground">{status.branch}</span>
                {status.files.length > 0
                  ? ` · ${status.files.length} changed file${status.files.length === 1 ? '' : 's'}`
                  : ' · working tree is clean'}
              </>
            ) : (
              'Pick a diff, choose agents, then run the review in the project terminal.'
            )}
          </p>
        </header>

        <ol className="grid grid-cols-4 gap-1.5">
          {STEPS.map((entry, index) => {
            const active = entry.id === step;
            const done = index < stepIndex;
            const StepIcon = entry.icon;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => setStep(entry.id)}
                  className={cn(
                    'w-full rounded-lg border px-2 py-2 text-left transition-colors',
                    active
                      ? 'border-primary/50 bg-primary/10'
                      : done
                        ? 'border-border bg-muted/40 hover:bg-muted'
                        : 'border-border bg-background/40 hover:bg-muted/50',
                  )}
                >
                  <span
                    className={cn(
                      'flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide',
                      active ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {done ? (
                      <Check className="h-3 w-3 shrink-0" />
                    ) : (
                      <StepIcon className="h-3 w-3 shrink-0" />
                    )}
                    {entry.label}
                  </span>
                  <span className="mt-0.5 hidden pl-[1.125rem] text-xs text-muted-foreground sm:block">
                    {entry.hint}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <div
        className={cn(
          'space-y-3 pb-5 pl-6 pr-5 pt-4',
          compact ? 'min-h-0 flex-1 overflow-y-auto' : 'min-h-[16rem]',
        )}
      >
        {step === 'diff' && (
          <>
            <ScopeCard
              selected={scope === 'working-tree'}
              title="Working tree"
              description="Uncommitted changes, or the last commit if the tree is clean."
              icon={Code}
              onClick={() => setScope('working-tree')}
            />
            <ScopeCard
              selected={scope === 'base-branch'}
              title="Compare to a branch"
              description="Everything this branch added since the base you pick."
              icon={GitBranch}
              onClick={() => setScope('base-branch')}
            >
              {scope === 'base-branch' && (
                <div className="mt-2.5 space-y-1.5" onClick={(event) => event.stopPropagation()}>
                  <Label>Base branch</Label>
                  <Combobox
                    className="w-full font-mono"
                    value={baseRef}
                    onChange={setBaseRef}
                    options={branchOptions}
                    placeholder="main"
                    searchPlaceholder="Search branches…"
                  />
                </div>
              )}
            </ScopeCard>
            <ScopeCard
              selected={scope === 'last-commits'}
              title="Last N commits"
              description="Review a short window of recent history on this branch."
              icon={GitCommit}
              onClick={() => setScope('last-commits')}
            >
              {scope === 'last-commits' && (
                <div className="mt-2.5 space-y-2" onClick={(event) => event.stopPropagation()}>
                  <Label htmlFor="diffray-commit-count">Commit count</Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Input
                      id="diffray-commit-count"
                      type="number"
                      min={1}
                      max={50}
                      value={commitCount}
                      onChange={(event) =>
                        setCommitCount(Math.max(1, Math.min(50, Number(event.target.value) || 1)))
                      }
                      className="w-24 font-mono"
                    />
                    {COMMIT_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setCommitCount(preset)}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-xs transition-colors',
                          commitCount === preset
                            ? 'border-primary/50 bg-primary/15 text-foreground'
                            : 'border-border text-muted-foreground hover:bg-muted/50',
                        )}
                      >
                        Last {preset}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Reviews everything since{' '}
                    <span className="font-mono text-foreground">HEAD~{commitCount}</span>.
                  </p>
                </div>
              )}
            </ScopeCard>
            <ScopeCard
              selected={scope === 'files'}
              title="Changed files"
              description={
                changedFiles.length > 0
                  ? 'Limit the review to files that already differ in git.'
                  : 'No changed files in the working tree right now.'
              }
              icon={GitPullRequest}
              disabled={changedFiles.length === 0}
              onClick={() => changedFiles.length > 0 && setScope('files')}
            >
              {scope === 'files' && changedFiles.length > 0 && (
                <div className="mt-2.5 space-y-2" onClick={(event) => event.stopPropagation()}>
                  <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border bg-background/60 p-2">
                    {changedFiles.map((file) => (
                      <label
                        key={file.path}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/60"
                      >
                        <Checkbox
                          checked={selectedFiles.has(file.path)}
                          onCheckedChange={() => toggleFile(file.path)}
                        />
                        <File className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate font-mono text-xs">{file.path}</span>
                      </label>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={fullFiles} onCheckedChange={setFullFiles} />
                    Review the whole file, not just the diff
                  </label>
                </div>
              )}
            </ScopeCard>
            <ScopeCard
              selected={scope === 'codebase'}
              title="Whole codebase"
              description="Every source file in the project, reviewed in full. No git diff involved."
              icon={FolderTree}
              onClick={() => setScope('codebase')}
            >
              {scope === 'codebase' && (
                <div className="mt-2.5 space-y-3" onClick={(event) => event.stopPropagation()}>
                  {repoFilesQuery.isPending ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Spinner className="h-3.5 w-3.5 animate-spin" /> Listing source files…
                    </p>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <Label>Folder</Label>
                        <Combobox
                          className="w-full font-mono"
                          value={codebaseFolder || ROOT_FOLDER_VALUE}
                          onChange={(next) =>
                            setCodebaseFolder(next === ROOT_FOLDER_VALUE ? '' : next)
                          }
                          options={folderOptions}
                          placeholder="Whole repository"
                          searchPlaceholder="Search folders…"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <label className="flex items-center gap-2 text-sm">
                          <Switch checked={includeTests} onCheckedChange={setIncludeTests} />
                          Include tests
                        </label>
                        <div className="space-y-1.5">
                          <Label htmlFor="diffray-files-per-pass">Files per pass</Label>
                          <Input
                            id="diffray-files-per-pass"
                            type="number"
                            min={1}
                            max={DIFFRAY_MAX_FILES_PER_PASS}
                            value={filesPerPass}
                            onChange={(event) =>
                              setFilesPerPass(
                                Math.max(
                                  1,
                                  Math.min(
                                    DIFFRAY_MAX_FILES_PER_PASS,
                                    Number(event.target.value) || 1,
                                  ),
                                ),
                              )
                            }
                            className="w-24 font-mono"
                          />
                        </div>
                      </div>

                      {codebaseFiles.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No reviewable source files here. Pick another folder, or turn tests on.
                        </p>
                      ) : (
                        <>
                          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border bg-background/60 p-2">
                            {codebaseFiles.slice(0, FILE_PREVIEW_LIMIT).map((file) => (
                              <label
                                key={file}
                                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/60"
                              >
                                <Checkbox
                                  checked={!skippedFiles.has(file)}
                                  onCheckedChange={() => toggleSkippedFile(file)}
                                />
                                <File className="h-3 w-3 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 truncate font-mono text-xs">{file}</span>
                              </label>
                            ))}
                            {codebaseFiles.length > FILE_PREVIEW_LIMIT && (
                              <p className="px-1 py-1 text-xs text-muted-foreground">
                                and {codebaseFiles.length - FILE_PREVIEW_LIMIT} more, all included
                              </p>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {reviewedCodebaseFiles.length} file
                            {reviewedCodebaseFiles.length === 1 ? '' : 's'} · {passes} pass
                            {passes === 1 ? '' : 'es'} · {passes * Math.max(agentIds.size, 1)} agent
                            runs. Each pass is its own review, so a large tree costs real tokens.
                          </p>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </ScopeCard>
          </>
        )}

        {step === 'agents' && (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Each agent reads the same diff in isolation, then findings are deduplicated and
                validated.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setAgentIds(
                    agentIds.size === DIFFRAY_AGENTS.length
                      ? new Set()
                      : new Set(allDiffrayAgentIds()),
                  )
                }
              >
                {agentIds.size === DIFFRAY_AGENTS.length ? 'Clear' : 'Select all'}
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {DIFFRAY_AGENTS.map((agent) => {
                const Icon = AGENT_ICON[agent.id];
                const checked = agentIds.has(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => toggleAgent(agent.id)}
                    className={cn(
                      'rounded-lg border border-l-4 px-3 py-3 text-left transition-colors',
                      AGENT_GUTTER[agent.id],
                      checked
                        ? 'border-primary/40 bg-primary/10'
                        : 'border-border bg-background/50 hover:bg-muted/40',
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      {agent.label}
                      {checked && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {agent.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {step === 'engine' && (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Pick the CLI that runs the agents, then the model it reviews with.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => setShowTradeoffs((prev) => !prev)}
              >
                <CircleInfo /> {showTradeoffs ? 'Hide' : 'Compare'} models
              </Button>
            </div>

            {showTradeoffs && <ModelTradeoffTable current={model} />}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {DIFFRAY_EXECUTORS.map((entry) => {
                const selected = executor === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => {
                      setExecutor(entry.id);
                      setModel('');
                    }}
                    className={cn(
                      'rounded-lg border px-3 py-3 text-left transition-colors',
                      selected
                        ? 'border-primary/50 bg-primary/10'
                        : 'border-border bg-background/50 hover:bg-muted/40',
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <CliLogo cliId={EXECUTOR_LOGO_ID[entry.id]} className="h-4 w-4 shrink-0" />
                      {entry.label}
                      {selected && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
                    </span>
                    <span className="mt-1 block pl-6 text-xs text-muted-foreground">
                      {entry.description}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="space-y-1.5">
              <Label>Model</Label>
              <Combobox
                value={model || '__default'}
                onChange={(next) => setModel(next === '__default' ? '' : next)}
                options={modelOptions}
                placeholder="Executor default"
              />
            </div>

            <div className="space-y-2">
              <Label>Severity filter</Label>
              <div className="flex flex-wrap gap-1.5">
                {allDiffraySeverities().map((severity) => {
                  const checked = severities.has(severity);
                  const SeverityIcon = SEVERITY_ICON[severity];
                  return (
                    <button
                      key={severity}
                      type="button"
                      onClick={() => toggleSeverity(severity)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs capitalize transition-colors',
                        checked
                          ? 'border-primary/50 bg-primary/15 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-muted/50',
                      )}
                    >
                      <SeverityIcon className="h-3 w-3 shrink-0" />
                      {severity}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
              <span className="flex items-start gap-2.5">
                <Shield className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>
                  <span className="block text-sm font-medium">Skip validation</span>
                  <span className="text-xs text-muted-foreground">
                    Faster, with more false positives.
                  </span>
                </span>
              </span>
              <Switch checked={skipValidation} onCheckedChange={setSkipValidation} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
              <span className="flex items-start gap-2.5">
                <Bolt className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>
                  <span className="block text-sm font-medium">Stream progress</span>
                  <span className="text-xs text-muted-foreground">
                    {jsonOutput
                      ? 'Off while findings go to a file, or the streamed output lands in the JSON.'
                      : 'Show each agent as it works in the terminal.'}
                  </span>
                </span>
              </span>
              <Switch
                checked={stream && !jsonOutput}
                onCheckedChange={setStream}
                disabled={jsonOutput}
              />
            </label>

            <div className="rounded-lg border border-border px-3 py-2.5">
              <label className="flex items-center justify-between gap-3">
                <span className="flex items-start gap-2.5">
                  <FileCog className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="block text-sm font-medium">Save findings as JSON</span>
                    <span className="text-xs text-muted-foreground">
                      Writes a machine-readable report into the project instead of printing it.
                    </span>
                  </span>
                </span>
                <Switch checked={jsonOutput} onCheckedChange={setJsonOutput} />
              </label>
              {jsonOutput && (
                <div className="mt-2.5 space-y-1.5 pl-6.5">
                  <Label htmlFor="diffray-json-file">Report file</Label>
                  <Input
                    id="diffray-json-file"
                    value={jsonFileName}
                    onChange={(event) => setJsonFileName(event.target.value)}
                    placeholder={DIFFRAY_DEFAULT_JSON_FILE}
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    {reportFiles.length > 1
                      ? `One file per pass, ${reportFiles[0]} through ${reportFiles[reportFiles.length - 1]}, written in ${projectName}.`
                      : `Written in ${projectName} as ${reportFiles[0] ?? DIFFRAY_DEFAULT_JSON_FILE}.`}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {step === 'launch' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {codebaseScript
                ? `The terminal gets one line, not ${commands.length} pasted commands. It runs a script that lists the source files itself, then reviews them ${filesPerPass} at a time. Nothing starts until you press Enter.`
                : 'The command is not run until you press Enter in the terminal. That keeps the review in your hands.'}
            </p>
            <div className="max-h-56 space-y-2 overflow-y-auto">
              {codebaseScript ? (
                <>
                  <CommandBlock label="what goes in the terminal">
                    {codebaseScript.commandFor(`…/${codebaseScript.fileName}`)}
                  </CommandBlock>
                  <CommandBlock label={`each of the ${commands.length} passes`}>
                    {codebaseScript.samplePassCommand}
                  </CommandBlock>
                </>
              ) : (
                commands.map((entry, index) => (
                  <CommandBlock
                    key={entry}
                    label={
                      commands.length > 1
                        ? `pass ${index + 1} of ${commands.length}`
                        : 'review hunk'
                    }
                  >
                    {entry}
                  </CommandBlock>
                ))
              )}
            </div>
            {codebaseScript && (
              <p className="text-xs text-muted-foreground">
                {reviewedCodebaseFiles.length} file
                {reviewedCodebaseFiles.length === 1 ? '' : 's'} ·{' '}
                {commands.length * Math.max(agentIds.size, 1)} agent runs. The script prints its
                progress per pass, and Ctrl+C stops it between files.
              </p>
            )}
            {reportFiles.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Findings land in{' '}
                <span className="font-mono text-foreground">
                  {reportFiles.length > 1
                    ? `${reportFiles[0]} … ${reportFiles[reportFiles.length - 1]}`
                    : reportFiles[0]}
                </span>
                , not in the terminal output.
              </p>
            )}
            <label className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
              <Switch className="mt-0.5" checked={writeConfig} onCheckedChange={setWriteConfig} />
              <FileCog className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">
                  {hasConfig ? 'Update' : 'Write'} {DIFFRAY_PROJECT_CONFIG_FILE}
                </span>
                <span className="text-xs text-muted-foreground">
                  Saves the executor and skips tests, dist, and node_modules on later runs.
                </span>
              </span>
            </label>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/40"
              onClick={() => void window.runova.shell.openExternal(DIFFRAY_GITHUB_APP_URL)}
            >
              <span className="flex items-center gap-2">
                <Github className="h-3.5 w-3.5 shrink-0" />
                Want automatic PR comments? Install the GitHub App instead.
              </span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </button>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border pb-5 pl-6 pr-5 pt-4">
        <Button variant="ghost" onClick={goBack} disabled={stepIndex === 0}>
          <ArrowLeft /> Back
        </Button>
        {step === 'launch' ? (
          <Button onClick={() => void handleLaunch()} disabled={!canContinue}>
            <Play /> Run review
          </Button>
        ) : (
          <Button onClick={goNext} disabled={!canContinue}>
            Continue <ArrowRight />
          </Button>
        )}
      </div>
    </div>
  );
}

function CommandBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background font-mono text-xs">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span className="text-primary">+</span>
        {label}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap px-3 py-2.5 text-foreground">
        {children}
      </pre>
    </div>
  );
}

/**
 * diffray's own speed/quality/cost table, so people are not guessing what a
 * model choice costs them. `current` highlights the row already selected.
 */
function ModelTradeoffTable({ current }: { current: string }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto rounded-lg border border-border bg-background/50">
        <table className="w-full min-w-[34rem] border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-2.5 py-2 text-left font-medium">Model</th>
              <th className="px-2.5 py-2 text-left font-medium">Speed</th>
              <th className="px-2.5 py-2 text-left font-medium">Quality</th>
              <th className="px-2.5 py-2 text-left font-medium">Cost</th>
              <th className="px-2.5 py-2 text-left font-medium">Best for</th>
            </tr>
          </thead>
          <tbody>
            {DIFFRAY_MODEL_TRADEOFFS.map((row) => {
              const selected = row.model === current;
              return (
                <tr
                  key={row.model}
                  className={cn(
                    'border-b border-border/60 last:border-b-0',
                    selected && 'bg-primary/10',
                  )}
                >
                  <td className="whitespace-nowrap px-2.5 py-2 font-mono text-foreground">
                    {row.model}
                  </td>
                  <td className="px-2.5 py-2">
                    <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                      {row.speed === 'fast' ? (
                        <Bolt className="h-3 w-3 shrink-0 text-warning" />
                      ) : (
                        <Clock className="h-3 w-3 shrink-0" />
                      )}
                      {row.speed === 'fast' ? 'Fast' : 'Moderate'}
                    </span>
                  </td>
                  <td
                    className={cn(
                      'whitespace-nowrap px-2.5 py-2',
                      row.recommended ? 'font-medium text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {row.quality}
                  </td>
                  <td className="px-2.5 py-2">
                    <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                      <span className="flex gap-0.5" aria-hidden>
                        {[1, 2, 3].map((dot) => (
                          <span
                            key={dot}
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              dot <= row.cost ? 'bg-primary' : 'bg-border',
                            )}
                          />
                        ))}
                      </span>
                      {row.costLabel}
                    </span>
                  </td>
                  <td className="px-2.5 py-2 text-muted-foreground">{row.bestFor}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        From diffray's docs. Some rows belong to executors other than the one you picked, so the
        model list below only offers what the selected CLI can run.
      </p>
    </div>
  );
}

function ScopeCard({
  selected,
  title,
  description,
  icon: Icon,
  disabled,
  onClick,
  children,
}: {
  selected: boolean;
  title: string;
  description: string;
  icon: typeof Code;
  disabled?: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border px-3 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'border-primary/50 bg-primary/10'
          : 'border-border bg-background/50 hover:bg-muted/40',
      )}
    >
      <span className="flex items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            {title}
            {selected && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
          {children}
        </span>
      </span>
    </button>
  );
}
