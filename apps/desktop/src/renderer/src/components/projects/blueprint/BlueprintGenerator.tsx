import {
  type AiProvider,
  CLI_REGISTRY,
  type CliDefinition,
  defaultEffortFor,
  EFFORT_LABELS,
  type EffortLevel,
  getCliDefinition,
  type Project,
  type RunModelOption,
  runProfileForTargetAI,
} from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { SHORT_EFFORT_LABELS } from '@/components/cli/RunSettingsFields';
import { CliLogo } from '@/components/cliLogos';
import { Combobox } from '@/components/ui/combobox';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import {
  type BlueprintGeneratorChoice,
  useBlueprintGeneratorStore,
} from '@/stores/blueprintGeneratorStore';
import { useCliStore } from '@/stores/cliStore';

/** Picker value for the OpenAI/Gemini/Ollama provider set in Settings instead of a CLI. */
const SETTINGS_PROVIDER = '__settings__';
/** Picker value for "let the CLI use whatever model it's configured with". */
const CLI_DEFAULT_MODEL = '__cli-default__';

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama',
};

/** The provider and model Settings would write the prompt with, or a null model when none is set. */
export interface SettingsEngine {
  provider: AiProvider;
  model: string | null;
}

export interface BlueprintGenerator {
  /** Null only while the installed CLIs are still being detected and nothing was picked before. */
  choice: BlueprintGeneratorChoice | null;
  detecting: boolean;
  /** CLIs that can answer a one-shot prompt and are installed here. */
  clis: CliDefinition[];
  settingsEngine: SettingsEngine | null;
  /** Models of the chosen CLI that a flag can pick. Empty for the Settings provider. */
  models: readonly RunModelOption[];
  model: RunModelOption | undefined;
  effortHint: string | null;
  /** One line naming what will write the prompt, e.g. "Claude Code · Opus 5.5 · High". */
  label: string;
  /** Short name for progress text, e.g. "Claude Code" or "OpenAI". */
  engineName: string;
  selectCli: (cliId: string | null) => void;
  selectModel: (modelId: string | null) => void;
  selectEffort: (effort: EffortLevel | null) => void;
}

/**
 * Which CLI, model and effort writes the Blueprint prompt, remembered per project. Until the user
 * picks one it follows the project's CLI, then the default CLI, then the first installed one, and
 * falls back to the Settings provider when no CLI that can answer a one-shot prompt is installed.
 */
export function useBlueprintGenerator(project: Project): BlueprintGenerator {
  const stored = useBlueprintGeneratorStore((s) => s.choices[project.id]);
  const setChoice = useBlueprintGeneratorStore((s) => s.setChoice);
  const defaultCliId = useCliStore((s) => s.defaultCliId);

  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
    meta: { silentLoading: true },
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
    meta: { silentLoading: true },
  });

  // On Windows a CLI that takes the prompt as an argument goes through cmd.exe, which cuts it at
  // a few thousand characters. A Blueprint request is long, so only list CLIs that read stdin.
  const windows = window.runova.platform === 'win32';
  const clis = CLI_REGISTRY.filter(
    (cli) =>
      cli.promptCommand &&
      (!windows || cli.promptInputMode === 'stdin') &&
      cliQuery.data?.find((c) => c.id === cli.id)?.installed,
  );
  const detecting = !cliQuery.isFetched;
  const installed = (id: string | null | undefined): id is string =>
    !!id && clis.some((cli) => cli.id === id);

  let choice: BlueprintGeneratorChoice | null;
  if (detecting) choice = stored ?? null;
  else if (stored && (stored.cliId === null || installed(stored.cliId))) choice = stored;
  else {
    const cliId = [project.cliId, defaultCliId].find(installed) ?? clis[0]?.id ?? null;
    choice = { cliId, modelId: null, effort: null };
  }

  const settings = settingsQuery.data;
  const settingsEngine: SettingsEngine | null = settings
    ? {
        provider: settings.promptBuilderProvider,
        model:
          (settings.promptBuilderProvider === 'openai'
            ? settings.openaiModel
            : settings.promptBuilderProvider === 'gemini'
              ? settings.geminiModel
              : settings.ollamaModel
          ).trim() || null,
      }
    : null;

  const cliId = choice?.cliId ?? null;
  const profile = cliId ? runProfileForTargetAI(cliId) : null;
  // A generic profile only describes models by class, which isn't something a flag can pick.
  const models = profile && !profile.generic ? profile.models : [];
  const model = models.find((m) => m.id === choice?.modelId);
  const effort =
    model && choice?.effort && model.efforts?.includes(choice.effort) ? choice.effort : null;

  const cliName = cliId ? (getCliDefinition(cliId)?.label ?? cliId) : null;
  const providerName = settingsEngine ? PROVIDER_LABELS[settingsEngine.provider] : 'AI provider';
  const label = !choice
    ? 'Detecting CLIs…'
    : cliName
      ? [cliName, model?.label ?? 'CLI default model', effort ? EFFORT_LABELS[effort] : null]
          .filter(Boolean)
          .join(' · ')
      : !settingsEngine
        ? 'AI provider (Settings)'
        : settingsEngine.model
          ? `${providerName} · ${settingsEngine.model} (Settings)`
          : `${providerName} (Settings, no model set)`;

  function update(next: BlueprintGeneratorChoice): void {
    setChoice(project.id, next);
  }

  return {
    choice,
    detecting,
    clis,
    settingsEngine,
    models,
    model,
    effortHint: model && !model.efforts?.length ? (profile?.effortHint ?? null) : null,
    label,
    engineName: cliName ?? providerName,
    selectCli: (next) => update({ cliId: next, modelId: null, effort: null }),
    selectModel: (modelId) => {
      const next = models.find((m) => m.id === modelId);
      update({
        cliId,
        modelId: next?.id ?? null,
        effort: next ? (defaultEffortFor(next) ?? null) : null,
      });
    },
    selectEffort: (next) => update({ cliId, modelId: choice?.modelId ?? null, effort: next }),
  };
}

function FieldLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>;
}

/** CLI, model and effort for writing the prompt. Lives in the Generate button's popover. */
export function BlueprintGeneratorFields({
  generator,
}: {
  generator: BlueprintGenerator;
}): React.JSX.Element {
  const { choice, detecting, clis, settingsEngine, models, model } = generator;
  const usingCli = !!choice?.cliId;
  const efforts = model?.efforts ?? [];
  const effort = choice?.effort && efforts.includes(choice.effort) ? choice.effort : null;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <FieldLabel>Written by</FieldLabel>
        <Combobox
          ariaLabel="Written by"
          className="h-8 text-xs"
          value={choice ? (choice.cliId ?? SETTINGS_PROVIDER) : ''}
          onChange={(value) => generator.selectCli(value === SETTINGS_PROVIDER ? null : value)}
          disabled={detecting}
          placeholder={detecting ? 'Detecting…' : 'Choose'}
          searchPlaceholder="Search CLIs…"
          options={[
            ...clis.map((cli) => ({
              value: cli.id,
              label: cli.name,
              icon: <CliLogo cliId={cli.id} className="h-3.5 w-3.5 shrink-0" />,
            })),
            { value: SETTINGS_PROVIDER, label: 'AI provider (Settings)' },
          ]}
        />
      </div>

      {usingCli ? (
        <>
          <div className="space-y-1.5">
            <FieldLabel>Model</FieldLabel>
            <Combobox
              ariaLabel="Model"
              className="h-8 text-xs"
              value={model?.id ?? CLI_DEFAULT_MODEL}
              onChange={(value) =>
                generator.selectModel(value === CLI_DEFAULT_MODEL ? null : value)
              }
              disabled={models.length === 0}
              placeholder="CLI default"
              searchPlaceholder="Search models…"
              options={[
                { value: CLI_DEFAULT_MODEL, label: 'CLI default' },
                ...models.map((m) => ({
                  value: m.id,
                  label: `${m.label} · ${m.tier}`,
                  keywords: [m.bestFor],
                })),
              ]}
            />
          </div>

          <div className="space-y-1.5">
            <FieldLabel>Effort</FieldLabel>
            <div
              role="radiogroup"
              aria-label="Effort"
              className={cn(
                'field-surface flex h-8 w-full items-stretch gap-0.5 rounded-full p-0.5',
                efforts.length === 0 && 'opacity-50',
              )}
            >
              {[null, ...efforts].map((level) => {
                const selected = effort === level;
                return (
                  <button
                    key={level ?? 'default'}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={level ? EFFORT_LABELS[level] : 'Auto'}
                    disabled={efforts.length === 0}
                    onClick={() => generator.selectEffort(level)}
                    className={cn(
                      'min-w-0 flex-1 cursor-pointer truncate rounded-full px-1.5 text-xs transition-colors disabled:pointer-events-none',
                      selected
                        ? 'bg-primary/15 font-medium text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]'
                        : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
                    )}
                  >
                    {level ? SHORT_EFFORT_LABELS[level] : 'Auto'}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {!model
                ? 'Pick a model to set the effort. Otherwise the CLI uses its own settings.'
                : (generator.effortHint ??
                  'Higher effort thinks longer before writing. Auto leaves it to the model.')}
            </p>
          </div>
        </>
      ) : choice ? (
        <p className="rounded-md border border-border/70 bg-background/40 px-2.5 py-2 text-[11px] leading-snug text-muted-foreground">
          {settingsEngine?.model
            ? `Uses ${PROVIDER_LABELS[settingsEngine.provider]} · ${settingsEngine.model} from Settings. There is no effort setting for it.`
            : 'No AI model is set in Settings, so the prompt is assembled from a template here.'}
        </p>
      ) : null}

      {!detecting && clis.length === 0 ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          No agent CLI that can answer a one-shot prompt is installed. Install Claude Code, Codex,
          or Gemini from CLI Manager to pick a model and effort.
        </p>
      ) : null}
    </div>
  );
}
