import {
  CLI_REGISTRY,
  defaultEffortFor,
  EFFORT_LABELS,
  type EffortLevel,
  runProfileForTargetAI,
} from '@runova/core';
import type { SshAgentPhase } from '@shared/apiTypes';
import { MAX_SSH_AGENT_MESSAGE_CHARS } from '@shared/sshAgentMessage';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CliLogo } from '@/components/cliLogos';
import { Play, Send, StopCircle, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { isMacPlatform } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import {
  type AssistantAiChoice,
  type AssistantProjectChoice,
  SETTINGS_AI,
  useDeployAssistantStore,
} from '@/stores/deployAssistantStore';

/**
 * Where the user says what the AI should do (E09 T8), and with which AI: the provider set in
 * Settings by default, or an installed agent CLI. A CLI with known models offers them next, and
 * a model with effort levels offers those after it, so the row only grows as far as the choice
 * goes. The pick is kept for the next run. A CLI can also work in one of the user's projects (the
 * code that runs on the server), reading it or, when they say so, editing it; that choice is kept
 * per server. While a run goes, the box sends it a message (read at
 * its next step) and Stop ends it; once it is over, the same box asks a follow-up on the same
 * server and context, and a stopped run can be carried on from where it was.
 */

/** Picker value for the OpenAI, Gemini or Ollama provider set in Settings. */
export const SETTINGS_PROVIDER = '__settings__';

/** Picker value for "let the CLI use whatever model it is set up with". */
const CLI_DEFAULT_MODEL = '__cli-default__';

/** What a Continue asks for. The AI is told what happened in the run it picks up. */
export const CONTINUE_PROMPT = 'Carry on from where you stopped.';

const PICKER = 'h-8 pl-3 pr-2 text-xs';

/** A picker with its name above it. They share the row, up to a width that still reads well. */
function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 max-w-64 flex-[1_1_7.5rem] flex-col gap-1">
      <Label htmlFor={id} className="text-[11px] font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Read only, or read and edit: what a CLI may do with the attached project's code. */
function AccessSwitch({
  allowEdits,
  disabled,
  onChange,
}: {
  allowEdits: boolean;
  disabled?: boolean;
  onChange: (allowEdits: boolean) => void;
}): React.JSX.Element {
  const choices = [
    { edits: false, label: 'Read only' },
    { edits: true, label: 'Read and edit' },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="What the AI may do with the code"
      className="field-surface flex h-8 w-full items-stretch gap-0.5 rounded-full p-0.5"
    >
      {choices.map((choice) => {
        const selected = allowEdits === choice.edits;
        return (
          <button
            key={choice.label}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(choice.edits)}
            className={cn(
              'min-w-0 flex-1 cursor-pointer truncate rounded-full px-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              selected
                ? 'bg-primary/15 font-medium text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]'
                : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
            )}
          >
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}

export function AssistantComposer({
  serverId,
  running,
  phase,
  followUp,
  canContinue = false,
  initialPrompt,
  disabled,
  onStart,
  onMessage,
  onStop,
}: {
  serverId: string;
  running: boolean;
  /** Where the run is, which decides what a message does to it. */
  phase?: SshAgentPhase;
  /** A run ended, so the next task is a follow-up. */
  followUp: boolean;
  /** A run was stopped or failed before it was done, so it can be carried on. */
  canContinue?: boolean;
  initialPrompt: string;
  disabled?: boolean;
  /** `project` is only ever set with a CLI, since the Settings provider cannot open files. */
  onStart: (
    prompt: string,
    ai: AssistantAiChoice,
    project: AssistantProjectChoice | null,
  ) => Promise<boolean>;
  /** Resolves true once the run took the message. */
  onMessage: (text: string) => Promise<boolean>;
  onStop: () => void;
}): React.JSX.Element {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [starting, setStarting] = useState(false);
  const picked = useDeployAssistantStore((state) => state.ai);
  const setAi = useDeployAssistantStore((state) => state.setAi);
  const attached = useDeployAssistantStore((state) => state.projects[serverId]);
  const setProject = useDeployAssistantStore((state) => state.setProject);
  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
    meta: { silentLoading: true },
  });
  const promptClis = CLI_REGISTRY.filter(
    (cli) => cli.promptCommand && cliQuery.data?.find((c) => c.id === cli.id)?.installed,
  );

  // A CLI picked last time that is not installed (any more) falls back to Settings' provider.
  const cliId = promptClis.some((cli) => cli.id === picked.cliId) ? picked.cliId : null;
  const profile = cliId ? runProfileForTargetAI(cliId) : null;
  // A generic profile only describes models by class, which is not something a flag can pick.
  const models = profile && !profile.generic ? profile.models : [];
  const model = models.find((m) => m.id === picked.modelId);
  const efforts = model?.efforts ?? [];
  const effort = picked.effort && efforts.includes(picked.effort) ? picked.effort : null;
  const ai: AssistantAiChoice = cliId
    ? { cliId, modelId: model?.id ?? null, effort: model ? effort : null }
    : SETTINGS_AI;

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
    enabled: cliId !== null,
    meta: { silentLoading: true },
  });
  const projects = projectsQuery.data ?? [];
  // A project removed from Runova since it was attached counts as none.
  const projectInfo = projects.find((p) => p.id === attached?.projectId);
  const project: AssistantProjectChoice | null = cliId && attached && projectInfo ? attached : null;

  function selectCli(value: string): void {
    setAi(
      value === SETTINGS_PROVIDER ? SETTINGS_AI : { cliId: value, modelId: null, effort: null },
    );
  }

  function selectModel(value: string): void {
    const next = models.find((m) => m.id === value);
    setAi({
      cliId,
      modelId: next?.id ?? null,
      effort: next ? (defaultEffortFor(next) ?? null) : null,
    });
  }

  async function begin(text: string, clearAfter: boolean): Promise<void> {
    if (starting) return;
    setStarting(true);
    try {
      if ((await onStart(text, ai, project)) && clearAfter) setPrompt('');
    } finally {
      setStarting(false);
    }
  }

  async function send(text: string): Promise<void> {
    if (starting) return;
    setStarting(true);
    try {
      // On false the text stays in the box, so nothing typed is lost.
      if (await onMessage(text)) setPrompt('');
    } finally {
      setStarting(false);
    }
  }

  function submit(): void {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    if (running) void send(trimmed);
    else void begin(trimmed, true);
  }

  const locked = running || disabled;
  // A question waits for its answer in the box above, which a message would not give.
  const asking = phase === 'needs-input' || phase === 'needs-password';
  const mod = isMacPlatform() ? 'Cmd' : 'Ctrl';
  const hint = !running
    ? `${mod}+Enter to ${followUp ? 'ask' : 'start'}`
    : asking
      ? 'Answer the question above to carry on'
      : phase === 'proposed'
        ? 'Sending skips the command waiting for you'
        : `${mod}+Enter to send. The AI reads it at its next step`;

  return (
    <div className="space-y-2">
      <Label htmlFor="deploy-assistant-task" className="text-xs">
        {running
          ? 'Message the AI'
          : followUp
            ? 'Ask a follow-up'
            : 'What should the AI look into?'}
      </Label>
      <Textarea
        id="deploy-assistant-task"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder={
          running
            ? 'e.g. Leave the database alone, or check the api container too'
            : 'e.g. Find out why the sender keeps restarting'
        }
        className="min-h-20 resize-none text-sm"
        disabled={disabled || (running && asking)}
        maxLength={running ? MAX_SSH_AGENT_MESSAGE_CHARS : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {/* One line, each picker labelled; Model and Effort only show once they can apply. */}
      <div role="group" aria-label="AI to use" className="flex flex-wrap gap-2">
        <Field id="deploy-assistant-ai" label="Which AI">
          <Combobox
            id="deploy-assistant-ai"
            className={PICKER}
            value={cliId ?? SETTINGS_PROVIDER}
            onChange={selectCli}
            disabled={locked}
            searchPlaceholder="Search…"
            options={[
              { value: SETTINGS_PROVIDER, label: 'AI provider (Settings)' },
              ...promptClis.map((cli) => ({
                value: cli.id,
                label: cli.name,
                icon: <CliLogo cliId={cli.id} className="h-3.5 w-3.5 shrink-0" />,
              })),
            ]}
          />
        </Field>
        {models.length > 0 && (
          <Field id="deploy-assistant-model" label="Model">
            <Combobox
              id="deploy-assistant-model"
              className={PICKER}
              value={model?.id ?? CLI_DEFAULT_MODEL}
              onChange={selectModel}
              disabled={locked}
              searchable={false}
              options={[
                { value: CLI_DEFAULT_MODEL, label: 'CLI default' },
                ...models.map((m) => ({ value: m.id, label: m.label, keywords: [m.tier] })),
              ]}
            />
          </Field>
        )}
        {efforts.length > 0 && (
          <Field id="deploy-assistant-effort" label="Effort">
            <Combobox
              id="deploy-assistant-effort"
              className={PICKER}
              value={effort ?? ''}
              onChange={(value) => setAi({ ...ai, effort: value as EffortLevel })}
              disabled={locked}
              searchable={false}
              placeholder="Default"
              options={efforts.map((level) => ({ value: level, label: EFFORT_LABELS[level] }))}
            />
          </Field>
        )}
      </div>
      {cliId && (
        <div className="space-y-1.5">
          <div role="group" aria-label="Project" className="flex flex-wrap gap-2">
            <Field id="deploy-assistant-project" label="Project for the code">
              <Combobox
                id="deploy-assistant-project"
                className={PICKER}
                value={project?.projectId ?? ''}
                onChange={(value) =>
                  setProject(
                    serverId,
                    value ? { projectId: value, allowEdits: attached?.allowEdits ?? false } : null,
                  )
                }
                disabled={locked}
                clearable
                placeholder={
                  projectsQuery.isFetched && projects.length === 0 ? 'No projects' : 'None'
                }
                searchPlaceholder="Search projects…"
                emptyText="No matching project."
                options={projects.map((p) => ({
                  value: p.id,
                  label: p.name,
                  keywords: [p.folderPath],
                }))}
              />
            </Field>
            {project && (
              <div className="flex min-w-0 max-w-64 flex-[1_1_9rem] flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">Access</span>
                <AccessSwitch
                  allowEdits={project.allowEdits}
                  disabled={locked}
                  onChange={(allowEdits) => setProject(serverId, { ...project, allowEdits })}
                />
              </div>
            )}
          </div>
          {project && projectInfo && (
            <p
              className={cn(
                'flex items-start gap-1.5 text-[11px] leading-tight',
                project.allowEdits ? 'text-warning' : 'text-muted-foreground',
              )}
            >
              {project.allowEdits && <TriangleAlert className="mt-px h-3 w-3 shrink-0" />}
              <span className="min-w-0 break-all">
                {project.allowEdits
                  ? `Edits go straight into ${projectInfo.folderPath}. Commit first so you can undo them.`
                  : `The AI can read ${projectInfo.folderPath} but not change it.`}
              </span>
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <p className="mr-auto min-w-0 text-[11px] leading-tight text-muted-foreground">{hint}</p>
        {running ? (
          <>
            <Button variant="danger" onClick={onStop}>
              <StopCircle /> Stop
            </Button>
            <Button
              aria-label="Send message"
              onClick={submit}
              disabled={!prompt.trim() || starting || asking || disabled}
            >
              <Send /> Send
            </Button>
          </>
        ) : (
          <>
            {canContinue && (
              <Button
                variant="soft"
                onClick={() => void begin(CONTINUE_PROMPT, false)}
                disabled={starting || disabled}
              >
                <Play /> Continue
              </Button>
            )}
            <Button onClick={submit} disabled={!prompt.trim() || starting || disabled}>
              <Send /> {followUp ? 'Ask' : 'Start'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
