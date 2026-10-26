import { branchNameProblem, branchSlug, type Project, type WorktreeInfo } from '@runova/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CliLogo } from '@/components/cliLogos';
import {
  Check,
  CircleX,
  FolderOpen,
  GitBranch,
  Sparkles,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { launchAgentTab, launchPromptTab, launchSetupTab } from '@/lib/workspace/launch';
import {
  type CreateStep,
  type CreateWorktreePlan,
  plannedSteps,
  runCreateWorktree,
} from '@/lib/workspace/worktreeFlow';
import type { CreateWorktreeRequest } from '@/stores/worktreeDialogStore';
import { useAgentChoices } from '../useAgentChoices';

/** Long enough that typing a branch name does not ask main for a path per keystroke. */
const PATH_DEBOUNCE_MS = 200;
/** Long enough to see every step tick over before the dialog gets out of the way. */
const CLOSE_AFTER_SUCCESS_MS = 450;

type Mode = 'new' | 'existing';
type Phase = 'form' | 'running' | 'failed';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function FieldLabel({
  htmlFor,
  children,
  hint,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {children}
      </label>
      {hint ? <span className="text-[11px] text-muted-foreground/80">{hint}</span> : null}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-lg border border-border bg-background/60 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === option.value
              ? 'bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function StepIcon({ status }: { status: CreateStep['status'] }): React.JSX.Element {
  if (status === 'running') return <Spinner className="h-3.5 w-3.5 animate-spin text-primary" />;
  if (status === 'done') return <Check className="h-3.5 w-3.5 text-success" />;
  if (status === 'error') return <CircleX className="h-3.5 w-3.5 text-destructive" />;
  return <span className="h-2.5 w-2.5 rounded-full border border-muted-foreground/40" />;
}

function StepList({ steps }: { steps: CreateStep[] }): React.JSX.Element {
  return (
    <ol aria-label="Progress" className="space-y-1">
      {steps.map((step) => (
        <li
          key={step.id}
          className={cn(
            'flex items-start gap-3 rounded-lg px-3 py-2 transition-colors',
            step.status === 'running' && 'bg-primary/[0.06]',
            step.status === 'error' && 'bg-destructive/[0.08]',
          )}
        >
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
            <StepIcon status={step.status} />
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block text-sm',
                step.status === 'pending' ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {step.label}
            </span>
            {step.detail ? (
              <span
                className={cn(
                  'mt-0.5 block break-words text-xs',
                  step.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {step.detail}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function FormSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-5" aria-label="Loading">
      <Skeleton className="h-16 rounded-lg" />
      <div className="grid grid-cols-[1fr_11rem] gap-3">
        <Skeleton className="h-9 rounded-lg" />
        <Skeleton className="h-9 rounded-lg" />
      </div>
      <Skeleton className="h-9 rounded-lg" />
      <Skeleton className="h-20 rounded-lg" />
    </div>
  );
}

/**
 * New worktree: a branch in a folder of its own, set up and ready for an agent. The form keeps
 * everything on one screen with sensible defaults, so the common case is a branch name and
 * Enter. Submitting turns the body into a step list, and a failure goes back to the form with
 * nothing lost.
 */
export function CreateWorktreeDialog({
  project,
  request,
  onClose,
}: {
  project: Project;
  request: CreateWorktreeRequest;
  onClose: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ids = { task: useId(), branch: useId(), setup: useId() };

  const defaultsQuery = useQuery({
    queryKey: queryKeys.worktreeDefaults(project.id),
    queryFn: () => window.runova.worktrees.defaults(project.id),
    staleTime: 0,
  });
  const copyQuery = useQuery({
    queryKey: [...queryKeys.worktreeDefaults(project.id), 'copy-preview'],
    queryFn: () => window.runova.worktrees.previewCopy(project.id, null),
    staleTime: 0,
  });
  const agents = useAgentChoices(project);

  const [task, setTask] = useState('');
  const [mode, setMode] = useState<Mode>(request.mode ?? 'new');
  const [branch, setBranch] = useState(request.mode === 'existing' ? '' : (request.branch ?? ''));
  const [existing, setExisting] = useState(
    request.mode === 'existing' ? (request.branch ?? '') : '',
  );
  const [base, setBase] = useState('');
  const [parentOverride, setParentOverride] = useState<string | null>(null);
  const [copyEnabled, setCopyEnabled] = useState(true);
  const [setupCommand, setSetupCommand] = useState<string | null>(null);
  const [saveSetup, setSaveSetup] = useState(false);
  const [agentChoice, setAgentChoice] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [steps, setSteps] = useState<CreateStep[]>([]);
  const suggestRef = useRef<string | null>(null);

  // A suggestion still running when the dialog closes is left to finish on its own otherwise.
  useEffect(
    () => () => {
      if (suggestRef.current) void window.runova.worktrees.cancelSuggestBranch(suggestRef.current);
    },
    [],
  );

  const defaults = defaultsQuery.data;
  const effectiveBase = base || defaults?.defaultBranch || '';
  const effectiveSetup = setupCommand ?? defaults?.setupCommand ?? '';
  const defaultAgent =
    agents.installed.find((choice) => choice.isDefault)?.cli.id ??
    agents.installed[0]?.cli.id ??
    '';
  const agentId = agentChoice ?? defaultAgent;
  const agent = agents.installed.find((choice) => choice.cli.id === agentId)?.cli ?? null;

  const chosenBranch = mode === 'new' ? branch.trim() : existing;
  const problem = mode === 'new' && branch ? branchNameProblem(branch.trim()) : null;
  const taken =
    mode === 'new' && !problem && defaults?.branches.some((b) => b.name === branch.trim());
  const heldElsewhere = (defaults?.branches ?? []).filter((b) => b.worktreePath);
  const existingOptions = (defaults?.branches ?? [])
    .filter((b) => !b.worktreePath && b.name !== defaults?.currentBranch)
    .map((b) => ({ value: b.name, label: b.name }));
  const branchOptions = (defaults?.branches ?? []).map((b) => ({ value: b.name, label: b.name }));
  const branchReady =
    mode === 'new' ? Boolean(branch.trim()) && !problem && !taken : Boolean(existing);

  const debouncedBranch = useDebounced(chosenBranch, PATH_DEBOUNCE_MS);
  const pathQuery = useQuery({
    queryKey: [...queryKeys.worktreeDefaults(project.id), 'path', debouncedBranch],
    queryFn: () => window.runova.worktrees.suggestPath(project.id, debouncedBranch),
    enabled: Boolean(debouncedBranch) && !branchNameProblem(debouncedBranch) && !parentOverride,
    staleTime: 0,
  });
  const separator = window.runova.platform === 'win32' ? '\\' : '/';
  const customPath =
    parentOverride && chosenBranch
      ? `${parentOverride.replace(/[\\/]+$/, '')}${separator}${branchSlug(chosenBranch)}`
      : null;
  const shownPath = customPath ?? (debouncedBranch === chosenBranch ? pathQuery.data : undefined);

  const copyFiles = copyEnabled ? (copyQuery.data ?? []) : [];
  const setupChanged = effectiveSetup.trim() !== project.worktreeSetup.command;
  const canCreate = phase === 'form' && Boolean(defaults?.isRepo) && branchReady;

  async function suggest(): Promise<void> {
    if (suggesting) {
      void window.runova.worktrees.cancelSuggestBranch(suggesting);
      setSuggesting(null);
      suggestRef.current = null;
      return;
    }
    const requestId = crypto.randomUUID();
    setSuggesting(requestId);
    setSuggestError(null);
    suggestRef.current = requestId;
    const result = await window.runova.worktrees.suggestBranch(project.id, task.trim(), requestId);
    if (suggestRef.current !== requestId) return;
    suggestRef.current = null;
    setSuggesting(null);
    if (result.ok && result.text) {
      setMode('new');
      setBranch(result.text);
    } else if (!result.cancelled) {
      setSuggestError(result.error ?? 'No suggestion came back.');
    }
  }

  function plan(): CreateWorktreePlan {
    return {
      project,
      input: {
        projectId: project.id,
        branch: chosenBranch,
        mode,
        base: mode === 'new' ? effectiveBase || null : null,
        path: customPath,
      },
      copyFiles,
      setupCommand: effectiveSetup,
      agent: agent ? { cliId: agent.id, name: agent.name, prompt: task.trim() } : null,
    };
  }

  async function submit(): Promise<void> {
    if (!canCreate) return;
    const current = plan();
    setSteps(plannedSteps(current));
    setPhase('running');
    if (saveSetup && setupChanged) {
      void window.runova.projects
        .update(project.id, {
          worktreeSetup: { ...project.worktreeSetup, command: effectiveSetup.trim() },
        })
        .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.projects }));
    }
    const outcome = await runCreateWorktree(current, setSteps, {
      create: async (input) => {
        const result = await window.runova.worktrees.create(input);
        // The new workspace resolves its folder from this list, so it must know the worktree
        // before the route changes rather than after the next refetch.
        if (result.ok) {
          queryClient.setQueryData<WorktreeInfo[]>(queryKeys.worktrees(project.id), (old) => [
            ...(old ?? []).filter((w) => w.id !== result.worktree.id),
            result.worktree,
          ]);
        }
        return result;
      },
      copyFiles: (projectId, worktreeId, files) =>
        window.runova.worktrees.copyFiles(projectId, worktreeId, files),
      open: (scopeId) => navigate(`/workspace/${scopeId}`),
      setup: (workspace, command) => launchSetupTab(workspace, command),
      launchAgent: (workspace, cliId, prompt) =>
        prompt ? launchPromptTab(workspace, { cliId, prompt }) : launchAgentTab(workspace, cliId),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees(project.id) });
    if (outcome.ok) {
      setTimeout(onClose, CLOSE_AFTER_SUCCESS_MS);
    } else {
      setPhase('failed');
    }
  }

  async function pickLocation(): Promise<void> {
    const start = parentOverride ?? pathQuery.data?.replace(/[\\/][^\\/]+$/, '') ?? null;
    const picked = await window.runova.worktrees.pickLocation(start);
    if (picked) setParentOverride(picked);
  }

  const failure = steps.find((step) => step.status === 'error' && step.id === 'create');

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Closing in the middle of a run would hide the steps, not stop them.
        if (!open && phase !== 'running') onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[88vh] w-[min(36rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <DialogHeader className="border-b border-border/70 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <GitBranch className="h-3.5 w-3.5" />
            </span>
            New worktree
          </DialogTitle>
          <DialogDescription className="text-xs">
            A separate folder and branch of {project.name}, with its own terminals, agents and
            changes. Your main checkout is not touched.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {phase !== 'form' ? (
            <StepList steps={steps} />
          ) : defaultsQuery.isPending ? (
            <FormSkeleton />
          ) : defaults && !defaults.isRepo ? (
            <div className="flex items-start gap-3 rounded-xl bg-warning/10 p-3 text-sm ring-1 ring-inset ring-warning/30">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p>
                {project.name} is not a git repository yet, so it cannot have worktrees. Initialize
                it from the Source control panel first.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <FieldLabel htmlFor={ids.task} hint="Optional">
                  Task
                </FieldLabel>
                <Textarea
                  id={ids.task}
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  rows={3}
                  placeholder="What should happen in this worktree? It names the branch and becomes the agent's first prompt."
                  className="min-h-0 resize-none text-[13px]"
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <Segmented<Mode>
                    label="Branch"
                    value={mode}
                    onChange={setMode}
                    options={[
                      { value: 'new', label: 'New branch' },
                      { value: 'existing', label: 'Existing branch' },
                    ]}
                  />
                  {mode === 'existing' && heldElsewhere.length > 0 ? (
                    <span className="text-[11px] text-muted-foreground">
                      {plural(heldElsewhere.length, 'branch')}{' '}
                      {heldElsewhere.length === 1 ? 'is' : 'are'} open in another worktree.
                    </span>
                  ) : null}
                </div>
                {mode === 'new' ? (
                  <div className="grid grid-cols-[1fr_11rem] gap-3">
                    <div>
                      <div className="relative">
                        <GitBranch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id={ids.branch}
                          aria-label="Branch name"
                          aria-invalid={Boolean(problem || taken)}
                          autoFocus
                          value={branch}
                          onChange={(event) => setBranch(event.target.value)}
                          placeholder="feat/my-change"
                          spellCheck={false}
                          className="pl-9 pr-10 font-mono text-[13px]"
                        />
                        {/* Positioned out here: the tooltip wraps a disabled button in a span of
                            its own, which would otherwise sit in the flow and stretch the field. */}
                        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2">
                          <SimpleTooltip
                            label={
                              suggesting
                                ? 'Stop suggesting'
                                : task.trim()
                                  ? 'Suggest a branch name from the task'
                                  : 'Describe the task first to get a suggestion'
                            }
                            wrapTrigger
                          >
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Suggest a branch name from the task"
                              disabled={!task.trim() && !suggesting}
                              onClick={() => void suggest()}
                              className="text-primary hover:bg-primary/10 hover:text-primary"
                            >
                              {suggesting ? (
                                <Spinner className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Sparkles className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </SimpleTooltip>
                        </div>
                      </div>
                    </div>
                    <Combobox
                      ariaLabel="Based on"
                      options={branchOptions}
                      value={effectiveBase}
                      onChange={(value) => setBase(value)}
                      placeholder="Base branch"
                      searchPlaceholder="Find a branch…"
                    />
                  </div>
                ) : (
                  <Combobox
                    ariaLabel="Branch"
                    options={existingOptions}
                    value={existing}
                    onChange={setExisting}
                    placeholder="Pick a branch"
                    searchPlaceholder="Find a branch…"
                    emptyText="No branch is free to open."
                  />
                )}
                {problem ? (
                  <p className="mt-1.5 text-xs text-destructive">{problem}</p>
                ) : taken ? (
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-warning">
                    A branch named {branch.trim()} already exists.
                    <button
                      type="button"
                      className="font-semibold underline-offset-2 hover:underline"
                      onClick={() => {
                        setExisting(branch.trim());
                        setMode('existing');
                      }}
                    >
                      Use the existing branch
                    </button>
                  </p>
                ) : suggestError ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">{suggestError}</p>
                ) : mode === 'new' ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Starts from {effectiveBase || 'the current branch'}.
                  </p>
                ) : null}
              </div>

              <div>
                <FieldLabel>Location</FieldLabel>
                <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/40 py-1.5 pl-3 pr-1.5">
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]" dir="rtl">
                    {/* rtl keeps the end of a long path, the part that differs, in view. */}
                    {shownPath ? (
                      <bdi>{shownPath}</bdi>
                    ) : chosenBranch && !problem ? (
                      <span className="shimmer inline-block h-3 w-48 rounded align-middle" />
                    ) : (
                      <span className="font-sans text-muted-foreground">
                        Pick a branch to see where it goes
                      </span>
                    )}
                  </span>
                  {parentOverride ? (
                    <Button variant="ghost" size="sm" onClick={() => setParentOverride(null)}>
                      Reset
                    </Button>
                  ) : null}
                  <Button variant="soft" size="sm" onClick={() => void pickLocation()}>
                    Change…
                  </Button>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-border/70 bg-background/30 p-3">
                <p className="text-xs font-medium text-muted-foreground">Setup</p>
                <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <Checkbox
                    checked={copyEnabled && copyFiles.length > 0}
                    disabled={!copyQuery.data?.length}
                    onCheckedChange={(checked) => setCopyEnabled(checked === true)}
                    aria-label="Copy local files"
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block">Copy local files</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {copyQuery.isPending ? (
                        <span className="shimmer inline-block h-3 w-32 rounded align-middle" />
                      ) : copyQuery.data?.length ? (
                        `${plural(copyQuery.data.length, 'file')}: ${copyQuery.data.join(', ')}`
                      ) : (
                        `Nothing matches ${defaults?.copyGlobs.join(', ') || 'the copy patterns'}`
                      )}
                    </span>
                  </span>
                </label>
                <div>
                  <FieldLabel htmlFor={ids.setup} hint="Runs in its own tab">
                    Setup command
                  </FieldLabel>
                  <Input
                    id={ids.setup}
                    value={effectiveSetup}
                    onChange={(event) => setSetupCommand(event.target.value)}
                    placeholder="pnpm install"
                    spellCheck={false}
                    className="font-mono text-[12px]"
                  />
                  {setupChanged && effectiveSetup.trim() ? (
                    <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox
                        checked={saveSetup}
                        onCheckedChange={(checked) => setSaveSetup(checked === true)}
                      />
                      Use this for every new worktree of {project.name}
                    </label>
                  ) : null}
                </div>
              </div>

              <div>
                <FieldLabel>Start an agent</FieldLabel>
                <div
                  role="radiogroup"
                  aria-label="Start an agent"
                  className="flex flex-wrap gap-1.5"
                >
                  {agents.loading
                    ? Array.from({ length: 3 }, (_, i) => (
                        <Skeleton key={i} className="h-8 w-28 rounded-lg" />
                      ))
                    : [
                        ...agents.installed.map((choice) => ({
                          id: choice.cli.id,
                          label: choice.cli.name,
                        })),
                        { id: '', label: 'No agent' },
                      ].map((option) => (
                        <button
                          key={option.id || 'none'}
                          type="button"
                          role="radio"
                          aria-checked={agentId === option.id}
                          onClick={() => setAgentChoice(option.id)}
                          className={cn(
                            // Drawn like a filter chip; the edge is a ring, since the global
                            // border colour would repaint a tinted border.
                            'flex h-8 cursor-pointer items-center gap-2 rounded-full px-3 text-xs ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            agentId === option.id
                              ? 'bg-primary/12 font-medium text-primary ring-primary/30'
                              : 'bg-foreground/[0.05] text-muted-foreground ring-foreground/[0.07] hover:bg-foreground/[0.08] hover:text-foreground',
                          )}
                        >
                          {option.id ? <CliLogo cliId={option.id} className="h-3.5 w-3.5" /> : null}
                          {option.label}
                        </button>
                      ))}
                </div>
                {agent && task.trim() ? (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    The task goes into {agent.name} as its first prompt, ready for you to send.
                  </p>
                ) : null}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-row items-center gap-2 border-t border-border/70 px-5 py-3 sm:justify-between">
          {phase === 'failed' ? (
            <>
              <span className="min-w-0 truncate text-xs text-destructive">
                {failure
                  ? 'The worktree was not created.'
                  : 'Created, with a problem along the way.'}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPhase('form')}>
                  Back
                </Button>
                <Button size="sm" onClick={onClose} variant="soft">
                  Close
                </Button>
              </div>
            </>
          ) : phase === 'running' ? (
            <span className="text-xs text-muted-foreground">Setting things up…</span>
          ) : (
            <>
              <span className="hidden text-[11px] text-muted-foreground sm:block">
                <kbd className="rounded border border-border px-1 py-px text-[10px] font-medium">
                  {window.runova.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter
                </kbd>{' '}
                to create
              </span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={onClose}>
                  Cancel
                </Button>
                {defaults?.isRepo === false ? null : (
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={!canCreate}
                    onClick={() => void submit()}
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    Create worktree
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
