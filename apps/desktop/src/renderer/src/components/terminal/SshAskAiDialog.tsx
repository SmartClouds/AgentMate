import {
  CLI_REGISTRY,
  defaultEffortFor,
  EFFORT_LABELS,
  type EffortLevel,
  runProfileForTargetAI,
} from '@agentmat/core';
import type { SshAgentHistoryRun, SshAgentMode, SshAgentRunSettings } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CliLogo } from '@/components/cliLogos';
import { History, Link, Play, Robot, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { TruncatedText } from '@/components/ui/truncated-text';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useCliStore } from '@/stores/cliStore';
import { type SshAskAiPrefill, startSshAgentTask, useSshAgentStore } from '@/stores/sshAgentStore';
import { AgentPromptField } from './AgentPromptField';
import { SSH_AGENT_MODES } from './sshAgentModes';

/** Picker value for the OpenAI/Gemini/Ollama provider set in Settings instead of a CLI. */
const SETTINGS_PROVIDER = '__settings__';
/** Picker value for "let the CLI use whatever model it's configured with". */
const CLI_DEFAULT_MODEL = '__cli-default__';
/** Past tasks the dialog offers to run again or continue. The history shows the rest. */
const RECENT_LIMIT = 4;

export type { SshAskAiPrefill };

function shortTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SshAskAiDialog({
  sessionId,
  target,
  serverId = null,
  prefill = null,
  open,
  onOpenChange,
}: {
  sessionId: string;
  /** An SSH session, or a shell running on this machine. */
  target: 'ssh' | 'local';
  /** The saved server an SSH tab is on, whose earlier tasks are offered. This tab's otherwise. */
  serverId?: string | null;
  /** A past task to start from, when the history opened the dialog for it. */
  prefill?: SshAskAiPrefill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const lastMode = useSshAgentStore((s) => s.lastMode);
  const lastAi = useSshAgentStore((s) => s.lastAi);
  const sessionPhase = useSshAgentStore((s) => s.sessions[sessionId]?.phase);
  const defaultCliId = useCliStore((s) => s.defaultCliId);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<SshAgentMode>(lastMode);
  const [cliValue, setCliValue] = useState<string | null>(null);
  const [modelValue, setModelValue] = useState(CLI_DEFAULT_MODEL);
  const [effort, setEffort] = useState<EffortLevel | null>(null);
  const [starting, setStarting] = useState(false);
  const [continueFrom, setContinueFrom] = useState<SshAgentHistoryRun | null>(null);
  /** Says so when a past task's CLI is not here any more and another one stands in. */
  const [cliNote, setCliNote] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const appliedPrefill = useRef<SshAskAiPrefill | null>(null);

  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.agentmat.cli.detectAll(),
    meta: { silentLoading: true },
  });

  const historyQuery = useQuery<SshAgentHistoryRun[]>({
    queryKey: serverId
      ? queryKeys.sshServerAgentHistory(serverId)
      : queryKeys.sshAgentHistory(sessionId),
    queryFn: () =>
      serverId
        ? window.agentmat.sshAgent.serverHistory(serverId)
        : window.agentmat.sshAgent.history(sessionId),
    enabled: open,
    meta: { silentLoading: true },
  });
  // A task still going is not something to start again; the bar is where it is handled.
  const recent = (historyQuery.data ?? [])
    .filter((run) => run.status !== 'running' && run.status !== 'paused')
    .slice(0, RECENT_LIMIT);

  // CLIs that can answer a one-shot prompt and are actually installed here.
  const promptClis = CLI_REGISTRY.filter(
    (cli) => cli.promptCommand && cliQuery.data?.find((c) => c.id === cli.id)?.installed,
  );
  const installed = (id: string | null | undefined): boolean =>
    !!id && promptClis.some((cli) => cli.id === id);
  const fallbackCli = (): string =>
    installed(defaultCliId) ? (defaultCliId as string) : (promptClis[0]?.id ?? SETTINGS_PROVIDER);

  // Seed the pickers once the installed CLIs are known: last run's choice, then the default CLI,
  // then the first installed one, then Settings' AI provider when no CLI is around at all.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seeded once, from what is known then
  useEffect(() => {
    if (cliValue !== null || !cliQuery.isFetched) return;
    if (lastAi && (lastAi.cliId === null || installed(lastAi.cliId))) {
      setCliValue(lastAi.cliId ?? SETTINGS_PROVIDER);
      setModelValue(lastAi.modelId ?? CLI_DEFAULT_MODEL);
      setEffort(lastAi.effort);
      return;
    }
    setCliValue(fallbackCli());
  }, [cliValue, cliQuery.isFetched, lastAi, defaultCliId]);

  const cliId = cliValue && cliValue !== SETTINGS_PROVIDER ? cliValue : null;
  const profile = cliId ? runProfileForTargetAI(cliId) : null;
  // A generic profile only describes models by class, which isn't something a flag can pick.
  const models = profile && !profile.generic ? profile.models : [];
  const model = models.find((m) => m.id === modelValue);
  const efforts = model?.efforts ?? [];

  function selectCli(value: string): void {
    setCliValue(value);
    setModelValue(CLI_DEFAULT_MODEL);
    setEffort(null);
    setCliNote(null);
  }

  function selectModel(value: string): void {
    setModelValue(value);
    const next = models.find((m) => m.id === value);
    setEffort(next ? (defaultEffortFor(next) ?? null) : null);
  }

  /** Sets the pickers the way a past task ran, with a stand-in for a CLI that is gone. */
  function applySettings(settings: SshAgentRunSettings | undefined): void {
    if (!settings) return;
    setMode(settings.mode);
    if (settings.cliId === null) {
      setCliValue(SETTINGS_PROVIDER);
      setModelValue(CLI_DEFAULT_MODEL);
      setEffort(null);
      setCliNote(null);
      return;
    }
    if (installed(settings.cliId)) {
      setCliValue(settings.cliId);
      setModelValue(settings.modelId ?? CLI_DEFAULT_MODEL);
      setEffort(settings.effort);
      setCliNote(null);
      return;
    }
    const stand = fallbackCli();
    setCliValue(stand);
    setModelValue(CLI_DEFAULT_MODEL);
    setEffort(null);
    const was = CLI_REGISTRY.find((cli) => cli.id === settings.cliId)?.name ?? settings.cliId;
    const now =
      stand === SETTINGS_PROVIDER
        ? 'the AI provider from Settings'
        : (CLI_REGISTRY.find((cli) => cli.id === stand)?.name ?? stand);
    setCliNote(`${was} is not installed here, so ${now} is used.`);
  }

  function runAgain(run: SshAgentHistoryRun): void {
    setContinueFrom(null);
    setPrompt(run.prompt);
    applySettings(run.settings);
    fieldRef.current?.focus();
  }

  function continueRun(run: SshAgentHistoryRun, followUp = ''): void {
    setContinueFrom(run);
    setPrompt(followUp);
    applySettings(run.settings);
    fieldRef.current?.focus();
  }

  // The history can open the dialog on a past task. It is applied once the CLIs are known, so a
  // missing CLI gets its stand-in, and only once, so the user's changes are not undone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: applied once per prefill
  useEffect(() => {
    if (!open || !prefill || !cliQuery.isFetched || appliedPrefill.current === prefill) return;
    appliedPrefill.current = prefill;
    if (prefill.intent === 'continue') continueRun(prefill.run, prefill.followUp);
    else runAgain(prefill.run);
  }, [open, prefill, cliQuery.isFetched]);

  // Opened again for a new task, it starts fresh rather than still continuing the last one.
  useEffect(() => {
    if (!open) {
      setContinueFrom(null);
      setCliNote(null);
      appliedPrefill.current = null;
    }
  }, [open]);

  const busyHere =
    sessionPhase !== undefined &&
    sessionPhase !== 'finished' &&
    sessionPhase !== 'stopped' &&
    sessionPhase !== 'error';

  async function handleStart(): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed || starting || cliValue === null) return;
    setStarting(true);
    try {
      await startSshAgentTask({
        sessionId,
        target,
        prompt: trimmed,
        mode,
        cliId,
        modelId: model?.id ?? null,
        effort: model && effort && efforts.includes(effort) ? effort : null,
        continueFromRunId: continueFrom?.id ?? null,
      });
      setPrompt('');
      setContinueFrom(null);
      onOpenChange(false);
    } catch (error) {
      toast.error((error as Error).message || 'Could not start the AI task.');
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Robot className="h-4 w-4" />
            Ask AI to run a task here
          </DialogTitle>
          <DialogDescription>
            {target === 'ssh'
              ? 'Describe what you want done on this server. '
              : 'Describe what you want done on this computer. '}
            The AI runs real commands in this session, so you&apos;ll see everything it does live in
            the terminal.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-3">
          {continueFrom && (
            <div
              role="status"
              aria-label="Continuing"
              className="flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-xs ring-1 ring-inset ring-primary/20"
            >
              <Link className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="shrink-0 text-muted-foreground">Continuing</span>
              <TruncatedText text={continueFrom.prompt} className="flex-1 font-medium" />
              <SimpleTooltip label="Start fresh instead">
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Start fresh instead"
                  onClick={() => {
                    setContinueFrom(null);
                    fieldRef.current?.focus();
                  }}
                >
                  <X />
                </Button>
              </SimpleTooltip>
            </div>
          )}

          <AgentPromptField
            ref={fieldRef}
            autoFocus
            value={prompt}
            onChange={setPrompt}
            purpose="task"
            target={target}
            ariaLabel="Task for the AI"
            placeholder={
              continueFrom
                ? 'What should the AI do next? It knows what happened last time.'
                : target === 'ssh'
                  ? 'e.g. Check disk usage, then list the 5 largest files in /var/log'
                  : 'e.g. Install the dependencies, then run the tests'
            }
            submitOn="mod-enter"
            onSubmit={() => void handleStart()}
            minHeight={96}
            maxHeight={240}
          />

          {recent.length > 0 && (
            <section aria-label="Recent tasks" className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted-foreground">
                <History className="h-3 w-3" />
                {serverId ? 'Recent on this server' : 'Recent in this terminal'}
              </span>
              <ul className="flex flex-col gap-0.5">
                {recent.map((run) => (
                  <li
                    key={run.id}
                    className={cn(
                      'group flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-foreground/5',
                      continueFrom?.id === run.id && 'bg-primary/5',
                    )}
                  >
                    <TruncatedText text={run.prompt} className="flex-1 text-foreground/90" />
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {shortTime(run.startedAt)}
                    </span>
                    <SimpleTooltip label="Put this prompt back in the box, set up the way it ran">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 shrink-0 gap-1 px-2 text-[11px]"
                        onClick={() => runAgain(run)}
                      >
                        <Play className="h-2.5 w-2.5" />
                        Run again
                      </Button>
                    </SimpleTooltip>
                    <SimpleTooltip label="Start a new task that knows what this one did">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 shrink-0 gap-1 px-2 text-[11px]"
                        onClick={() => continueRun(run)}
                      >
                        <Link className="h-2.5 w-2.5" />
                        Continue
                      </Button>
                    </SimpleTooltip>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label className="text-xs">CLI</Label>
              <Combobox
                className="h-8 text-xs"
                value={cliValue ?? ''}
                onChange={selectCli}
                disabled={!cliQuery.isFetched}
                placeholder={cliQuery.isFetched ? 'Choose' : 'Detecting…'}
                searchPlaceholder="Search CLIs…"
                options={[
                  ...promptClis.map((cli) => ({
                    value: cli.id,
                    label: cli.name,
                    icon: <CliLogo cliId={cli.id} className="h-3.5 w-3.5 shrink-0" />,
                  })),
                  { value: SETTINGS_PROVIDER, label: 'AI provider (Settings)' },
                ]}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label className="text-xs">Model</Label>
              <Combobox
                className="h-8 text-xs"
                value={cliId ? modelValue : ''}
                onChange={selectModel}
                disabled={models.length === 0}
                placeholder={cliId ? 'CLI default' : 'From Settings'}
                searchPlaceholder="Search models…"
                options={[
                  { value: CLI_DEFAULT_MODEL, label: 'CLI default' },
                  ...models.map((m) => ({ value: m.id, label: m.label })),
                ]}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label className="text-xs">Effort</Label>
              <Combobox
                className="h-8 text-xs"
                value={effort && efforts.includes(effort) ? effort : ''}
                onChange={(value) => setEffort(value as EffortLevel)}
                disabled={efforts.length === 0}
                placeholder={model ? 'Not adjustable' : 'Default'}
                searchPlaceholder="Search…"
                options={efforts.map((level) => ({ value: level, label: EFFORT_LABELS[level] }))}
              />
            </div>
          </div>
          {cliNote && <p className="-mt-1 text-xs text-muted-foreground">{cliNote}</p>}
          {cliQuery.isFetched && promptClis.length === 0 && (
            <p className="-mt-1 text-xs text-muted-foreground">
              No agent CLI with a non-interactive mode is installed, so the AI provider from
              Settings is used. Install Claude Code, Codex, or Gemini from CLI Manager to pick one.
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            {SSH_AGENT_MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={mode === option.value}
                onClick={() => setMode(option.value)}
                className={cn(
                  'flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-xs transition-colors',
                  mode === option.value
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:bg-foreground/5',
                )}
              >
                <span className="font-medium text-foreground">{option.label}</span>
                <span className="text-muted-foreground">{option.description}</span>
              </button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <SimpleTooltip
            label={busyHere ? 'An AI task is already running in this terminal' : null}
            wrapTrigger
          >
            <Button
              onClick={() => void handleStart()}
              disabled={!prompt.trim() || starting || cliValue === null || busyHere}
              aria-label={continueFrom ? 'Continue task' : 'Start'}
            >
              {starting ? 'Starting…' : continueFrom ? 'Continue task' : 'Start'}
            </Button>
          </SimpleTooltip>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
