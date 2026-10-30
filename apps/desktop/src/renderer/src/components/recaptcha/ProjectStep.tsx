import type {
  RecaptchaAccount,
  RecaptchaSetupProgress,
  RecaptchaSetupStep,
} from '@shared/deployRecaptchaTypes';
import { recaptchaErrorCode } from '@shared/recaptchaErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Check, CircleX, FolderPlus, Sparkles, Spinner } from '@/components/icons';
import { FOOTER_HAIRLINE, Notice, Problem, SearchPill, SectionCard } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { recaptchaFailureText, useRecaptchaError } from '@/lib/recaptcha/feedback';
import { cn } from '@/lib/utils';

type StepState = 'waiting' | 'running' | 'done' | 'failed';

interface Setup {
  projectId: string;
  steps: Record<RecaptchaSetupStep | 'ready', StepState>;
  problem: string | null;
}

const SEARCH_FROM = 7;

const STATE_WORDS: Record<StepState, string> = {
  waiting: 'waiting',
  running: 'working',
  done: 'done',
  failed: 'failed',
};

function stepLabel(step: keyof Setup['steps'], state: StepState): string {
  if (step === 'project') return state === 'done' ? 'Project found' : 'Checking the project';
  if (step === 'api') return state === 'done' ? 'reCAPTCHA is on' : 'Turning on reCAPTCHA';
  return 'Ready for keys';
}

function StepIcon({ state }: { state: StepState }): React.JSX.Element {
  if (state === 'done') return <Check className="h-3.5 w-3.5 text-success" />;
  if (state === 'running') return <Spinner className="h-3.5 w-3.5 text-primary" />;
  if (state === 'failed') return <CircleX className="h-3.5 w-3.5 text-destructive" />;
  return <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />;
}

/** The checklist shown while a project is made ready, step by step as the main process reports. */
function SetupChecklist({ setup }: { setup: Setup }): React.JSX.Element {
  return (
    <ul aria-label="Setting up the project" className="space-y-2">
      {(['project', 'api', 'ready'] as const).map((step) => {
        const state = setup.steps[step];
        const label = stepLabel(step, state);
        return (
          <li
            key={step}
            aria-label={`${label}, ${STATE_WORDS[state]}`}
            className={cn(
              'flex items-center gap-3 text-sm',
              state === 'waiting' ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-foreground/[0.05]">
              <StepIcon state={state} />
            </span>
            {label}
          </li>
        );
      })}
    </ul>
  );
}

function freshSetup(projectId: string): Setup {
  return {
    projectId,
    steps: { project: 'running', api: 'waiting', ready: 'waiting' },
    problem: null,
  };
}

/**
 * Picking the Google Cloud project the keys live in (E40), or letting Runova make one. A picked
 * project is made ready at once, with a checklist that follows the main process: the project is
 * reached, reCAPTCHA is turned on when it is off, and the keys open.
 */
export function ProjectStep({
  account,
  onDone,
  onCancel,
}: {
  account: RecaptchaAccount;
  onDone: () => void;
  /** Leaves the picker without changing the project; only when the account already has one. */
  onCancel?: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: queryKeys.recaptchaProjects(account.id),
    queryFn: () => window.runova.deployRecaptcha.listProjects(account.id),
  });
  const loadProblem = useRecaptchaError(projects.error);
  const [search, setSearch] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [creating, setCreating] = useState(false);
  const [createProblem, setCreateProblem] = useState<string | null>(null);

  useEffect(
    () =>
      window.runova.deployRecaptcha.onProgress((progress: RecaptchaSetupProgress) => {
        if (progress.accountId !== account.id) return;
        setSetup((current) =>
          current && current.projectId === progress.projectId
            ? { ...current, steps: { ...current.steps, [progress.step]: progress.state } }
            : current,
        );
      }),
    [account.id],
  );

  async function prepare(projectId: string): Promise<void> {
    setSetup(freshSetup(projectId));
    try {
      await window.runova.deployRecaptcha.prepareProject({ accountId: account.id, projectId });
      setSetup({
        projectId,
        steps: { project: 'done', api: 'done', ready: 'done' },
        problem: null,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.recaptchaStatus });
      onDone();
    } catch (error) {
      const permission = recaptchaErrorCode(error) === 'permission';
      const message = recaptchaFailureText(error, queryClient);
      setSetup((current) => ({
        projectId,
        steps: {
          project: current?.steps.project === 'done' ? 'done' : 'failed',
          api: current?.steps.project === 'done' ? 'failed' : 'waiting',
          ready: 'waiting',
        },
        problem: permission
          ? `${message} Setting up a project takes the Owner or Editor role on it. Pick a project you own, or let Runova make one.`
          : message,
      }));
    }
  }

  async function create(): Promise<void> {
    setCreating(true);
    setCreateProblem(null);
    try {
      const project = await window.runova.deployRecaptcha.createProject(account.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.recaptchaProjects(account.id) });
      await prepare(project.projectId);
    } catch (error) {
      setCreateProblem(recaptchaFailureText(error, queryClient));
    } finally {
      setCreating(false);
    }
  }

  const all = projects.data ?? [];
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? all.filter(
        (project) =>
          project.name.toLowerCase().includes(needle) ||
          project.projectId.toLowerCase().includes(needle),
      )
    : all;

  let body: React.ReactNode;
  if (setup) {
    body = (
      <div className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">
          Getting <span className="font-mono text-foreground">{setup.projectId}</span> ready for
          reCAPTCHA. This usually takes under a minute.
        </p>
        <SetupChecklist setup={setup} />
        {setup.problem && (
          <Notice
            tone="destructive"
            action={
              <div className="flex gap-1.5">
                <Button size="sm" variant="soft" onClick={() => void prepare(setup.projectId)}>
                  Try again
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSetup(null)}>
                  Choose another project
                </Button>
              </div>
            }
          >
            {setup.problem}
          </Notice>
        )}
      </div>
    );
  } else {
    body = (
      <div className="space-y-3 p-4">
        <button
          type="button"
          disabled={creating}
          onClick={() => void create()}
          className="group flex w-full items-center gap-3 rounded-xl bg-primary/8 p-3 text-left outline-none ring-1 ring-inset ring-primary/25 transition-colors hover:bg-primary/12 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            {creating ? <Spinner className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">
              Create a project for me
            </span>
            <span className="block text-xs text-muted-foreground">
              Runova makes "Runova reCAPTCHA" in your Google account and sets it up. Free, no
              billing needed.
            </span>
          </span>
        </button>
        {createProblem && <Notice tone="destructive">{createProblem}</Notice>}

        {projects.isPending ? (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-11 w-full rounded-xl" />
            ))}
          </div>
        ) : projects.isError ? (
          <Problem message={loadProblem ?? ''} onRetry={() => void projects.refetch()} />
        ) : all.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">
            This Google account has no projects yet. Let Runova make one above.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 px-1">
              <p className="text-xs font-medium text-muted-foreground">Or use one you have</p>
              {all.length >= SEARCH_FROM && (
                <SearchPill
                  type="search"
                  label="Search projects"
                  clearLabel="Clear filter"
                  placeholder="Name or ID"
                  value={search}
                  onValueChange={setSearch}
                  className="w-56"
                />
              )}
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {shown.map((project) => (
                <button
                  key={project.projectId}
                  type="button"
                  onClick={() => void prepare(project.projectId)}
                  className="flex min-w-0 items-center gap-3 rounded-xl bg-foreground/[0.03] px-3 py-2 text-left outline-none ring-1 ring-inset ring-foreground/[0.07] transition-colors hover:bg-foreground/[0.07] focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FolderPlus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-foreground">{project.name}</span>{' '}
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {project.projectId}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {shown.length === 0 && (
              <p className="px-1 text-sm text-muted-foreground">No project matches that.</p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <SectionCard
      flush
      icon={<FolderPlus className="h-4 w-4" />}
      title="Choose a Google Cloud project"
      description="Your keys live in a Google Cloud project. Pick one, or let Runova make one just for reCAPTCHA."
      actions={
        onCancel &&
        account.projectId &&
        !setup && (
          <Button size="sm" variant="soft" onClick={onCancel}>
            Keep {account.projectId}
          </Button>
        )
      }
      className="flex min-w-0 flex-col"
    >
      <div className={FOOTER_HAIRLINE}>{body}</div>
    </SectionCard>
  );
}
