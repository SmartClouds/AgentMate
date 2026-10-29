import {
  CLI_REGISTRY,
  defaultEffortFor,
  EFFORT_LABELS,
  type EffortLevel,
  runProfileForTargetAI,
} from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CliLogo } from '@/components/cliLogos';
import { Play, Send, StopCircle } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { isMacPlatform } from '@/lib/shortcuts';
import {
  type AssistantAiChoice,
  SETTINGS_AI,
  useDeployAssistantStore,
} from '@/stores/deployAssistantStore';

/**
 * Where the user says what the AI should do (E09 T8), and with which AI: the provider set in
 * Settings by default, or an installed agent CLI. A CLI with known models offers them next, and
 * a model with effort levels offers those after it, so the row only grows as far as the choice
 * goes. The pick is kept for the next run. While a run goes, the button stops it; once it is over,
 * the same box asks a follow-up on the same server and context, and a stopped run can be carried
 * on from where it was.
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

export function AssistantComposer({
  running,
  followUp,
  canContinue = false,
  initialPrompt,
  disabled,
  onStart,
  onStop,
}: {
  running: boolean;
  /** A run ended, so the next task is a follow-up. */
  followUp: boolean;
  /** A run was stopped or failed before it was done, so it can be carried on. */
  canContinue?: boolean;
  initialPrompt: string;
  disabled?: boolean;
  onStart: (prompt: string, ai: AssistantAiChoice) => Promise<boolean>;
  onStop: () => void;
}): React.JSX.Element {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [starting, setStarting] = useState(false);
  const picked = useDeployAssistantStore((state) => state.ai);
  const setAi = useDeployAssistantStore((state) => state.setAi);
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
      if ((await onStart(text, ai)) && clearAfter) setPrompt('');
    } finally {
      setStarting(false);
    }
  }

  function start(): void {
    const trimmed = prompt.trim();
    if (trimmed) void begin(trimmed, true);
  }

  const locked = running || disabled;

  return (
    <div className="space-y-2">
      <Label htmlFor="deploy-assistant-task" className="text-xs">
        {followUp ? 'Ask a follow-up' : 'What should the AI look into?'}
      </Label>
      <Textarea
        id="deploy-assistant-task"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="e.g. Find out why the sender keeps restarting"
        className="min-h-20 resize-none text-sm"
        disabled={locked}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            start();
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
      <div className="flex items-center justify-end gap-2">
        {!running && (
          <p className="mr-auto truncate text-[11px] text-muted-foreground">
            {isMacPlatform() ? 'Cmd' : 'Ctrl'}+Enter to {followUp ? 'ask' : 'start'}
          </p>
        )}
        {running ? (
          <Button variant="danger" onClick={onStop}>
            <StopCircle /> Stop
          </Button>
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
            <Button onClick={start} disabled={!prompt.trim() || starting || disabled}>
              <Send /> {followUp ? 'Ask' : 'Start'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
