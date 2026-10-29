import { CLI_REGISTRY, type Project } from '@runova/core';
import {
  AUTO_FIX_DEFAULT_ATTEMPTS,
  AUTO_FIX_MAX_ATTEMPTS,
  type AutoFixStartInput,
} from '@shared/ciAutoFixTypes';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cliOptionIcon } from '@/components/cliLogos';
import { Minus, Plus, Spinner, Wand2 } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { queryKeys } from '@/lib/queryKeys';
import { projectCliId } from '@/lib/workspace/launch';
import { cliName } from './autoFixView';
import { useAutoFixActions } from './useAutoFix';

/** The run auto-fix is switched on for. Without a run id it waits for a run just dispatched. */
export type AutoFixTarget = Omit<
  AutoFixStartInput,
  'cliId' | 'runArgs' | 'runLabel' | 'maxAttempts'
>;

/** Installed agent CLIs, and the one auto-fix would pick for this project. */
export function useAutoFixCliChoice(projectId: string): {
  clis: { id: string; name: string }[];
  detecting: boolean;
  preferred: string | null;
  maxAttempts: number;
  projectName: string | null;
} {
  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
    meta: { silentLoading: true },
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  });
  const clis = CLI_REGISTRY.filter(
    (cli) => cliQuery.data?.find((entry) => entry.id === cli.id)?.installed,
  ).map((cli) => ({ id: cli.id, name: cli.name }));
  const project = (projectsQuery.data as Project[] | undefined)?.find(
    (item) => item.id === projectId,
  );
  const isInstalled = (id: string | null | undefined): id is string =>
    Boolean(id) && clis.some((cli) => cli.id === id);
  const preferred =
    [settingsQuery.data?.ciAutoFixCliId, project ? projectCliId(project) : null].find(
      isInstalled,
    ) ??
    clis[0]?.id ??
    null;
  return {
    clis,
    detecting: !cliQuery.isFetched || !settingsQuery.isFetched,
    preferred,
    maxAttempts: settingsQuery.data?.ciAutoFixMaxAttempts ?? AUTO_FIX_DEFAULT_ATTEMPTS,
    projectName: project?.name ?? null,
  };
}

function tries(count: number): string {
  return `${count} ${count === 1 ? 'try' : 'tries'}`;
}

/**
 * Switching auto-fix on for one run: which CLI fixes it and how many tries it gets, with what will
 * happen spelled out underneath before anything starts.
 */
export function AutoFixSetup({
  target,
  onDone,
}: {
  target: AutoFixTarget;
  onDone: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const choice = useAutoFixCliChoice(target.projectId);
  const actions = useAutoFixActions();
  const [pickedCli, setCli] = useState<string | null>(null);
  const [pickedAttempts, setAttempts] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const cliId = pickedCli ?? choice.preferred;
  const attempts = pickedAttempts ?? choice.maxAttempts;
  const run = target.runNumber ? `run #${target.runNumber}` : 'the run';
  const project = choice.projectName ?? 'the project';

  async function turnOn(): Promise<void> {
    if (!cliId) return;
    setBusy(true);
    try {
      const started = await actions.start({ ...target, cliId, maxAttempts: attempts });
      if (started) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-[22rem] space-y-3">
      <div className="space-y-0.5">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Wand2 className="h-3.5 w-3.5 text-primary" />
          Auto-fix this run
        </h3>
        <p className="text-[11px] text-muted-foreground">
          {target.workflowName} · {target.branch}
        </p>
      </div>

      {!choice.detecting && choice.clis.length === 0 ? (
        <Notice
          tone="warning"
          size="sm"
          action={
            <Button size="xs" variant="soft" onClick={() => navigate('/cli-manager')}>
              Open CLI Manager
            </Button>
          }
        >
          No agent CLI is installed. Install one to let auto-fix work.
        </Notice>
      ) : (
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">Agent</p>
            <Combobox
              ariaLabel="Agent CLI for auto-fix"
              value={cliId ?? ''}
              onChange={setCli}
              disabled={choice.detecting}
              placeholder={choice.detecting ? 'Finding CLIs…' : 'Pick a CLI'}
              searchable={false}
              options={choice.clis.map((cli) => ({
                value: cli.id,
                label: cli.name,
                icon: cliOptionIcon(cli.id),
              }))}
            />
          </div>
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">Tries</p>
            <div className="flex h-9 items-center gap-0.5 rounded-lg bg-foreground/[0.04] px-1 ring-1 ring-inset ring-foreground/[0.08]">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Fewer tries"
                disabled={attempts <= 1}
                onClick={() => setAttempts(Math.max(1, attempts - 1))}
              >
                <Minus className="h-3 w-3" />
              </Button>
              <output aria-live="polite" className="w-5 text-center text-sm tabular-nums">
                {attempts}
              </output>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="More tries"
                disabled={attempts >= AUTO_FIX_MAX_ATTEMPTS}
                onClick={() => setAttempts(Math.min(AUTO_FIX_MAX_ATTEMPTS, attempts + 1))}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {cliId ? (
        <p className="text-xs leading-relaxed text-foreground/85">
          {`If ${run} fails, ${cliName(cliId)} fixes it in a new tab of ${project}. Runova then commits the fix, pushes it to ${target.branch} and checks the next run, up to ${tries(attempts)}.`}
        </p>
      ) : null}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {`Keep ${project} on ${target.branch} with nothing uncommitted, so only the fix goes into the commit.`}
      </p>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={!cliId || busy || choice.detecting}
          onClick={() => void turnOn()}
        >
          {busy ? (
            <Spinner className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Wand2 className="h-3.5 w-3.5" />
          )}
          Turn on auto-fix
        </Button>
      </div>
    </div>
  );
}
