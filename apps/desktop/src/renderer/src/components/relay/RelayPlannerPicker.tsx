import {
  CLI_REGISTRY,
  type CliDefinition,
  defaultEffortFor,
  EFFORT_LABELS,
  type EffortLevel,
  getCliDefinition,
  type RunModelOption,
  runProfileForTargetAI,
} from '@agentmat/core';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SHORT_EFFORT_LABELS } from '@/components/cli/RunSettingsFields';
import { CliLogo } from '@/components/cliLogos';
import { Combobox } from '@/components/ui/combobox';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useCliStore } from '@/stores/cliStore';

const CLI_DEFAULT_MODEL = '__cli-default__';

interface PlannerChoice {
  cliId: string | null;
  modelId: string | null;
  effort: EffortLevel | null;
}

interface PlannerStore {
  /** The last planner picked, for every project: planning is a habit, not a project setting. */
  choice: PlannerChoice | null;
  setChoice: (choice: PlannerChoice) => void;
}

export const useRelayPlannerStore = create<PlannerStore>()(
  persist(
    (set) => ({
      choice: null,
      setChoice: (choice) => set({ choice }),
    }),
    { name: 'agentmate-relay-planner' },
  ),
);

export interface RelayPlanner {
  /** Null while the installed CLIs are being detected and nothing was picked before. */
  choice: PlannerChoice | null;
  detecting: boolean;
  clis: CliDefinition[];
  models: readonly RunModelOption[];
  model: RunModelOption | undefined;
  efforts: readonly EffortLevel[];
  effort: EffortLevel | null;
  /** "Claude Code · Opus 5.5 · High". */
  label: string;
  /** Short name for progress text. */
  cliName: string;
  /** What the planner IPC takes. */
  input: { cliId: string | null; model: string | null; effort: string | null };
  selectCli: (cliId: string) => void;
  selectModel: (modelId: string | null) => void;
  selectEffort: (effort: EffortLevel | null) => void;
}

/**
 * Which CLI, model and effort plans the tasks. The planner reads the repository without changing
 * it, so it has to be an agent CLI that answers one prompt and exits; on Windows only those that
 * read the prompt from stdin, since a plan request is too long for a command line.
 */
export function useRelayPlanner(preferredCliId?: string | null): RelayPlanner {
  const stored = useRelayPlannerStore((s) => s.choice);
  const setChoice = useRelayPlannerStore((s) => s.setChoice);
  const defaultCliId = useCliStore((s) => s.defaultCliId);
  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.agentmat.cli.detectAll(),
    meta: { silentLoading: true },
  });

  const windows = window.agentmat.platform === 'win32';
  const clis = CLI_REGISTRY.filter(
    (cli) =>
      cli.promptCommand &&
      (!windows || cli.promptInputMode === 'stdin') &&
      cliQuery.data?.find((entry) => entry.id === cli.id)?.installed,
  );
  const detecting = !cliQuery.isFetched;
  const installed = (id: string | null | undefined): id is string =>
    Boolean(id) && clis.some((cli) => cli.id === id);

  let choice: PlannerChoice | null;
  if (stored && installed(stored.cliId)) choice = stored;
  else if (detecting) choice = null;
  else {
    const cliId = [preferredCliId, defaultCliId].find(installed) ?? clis[0]?.id ?? null;
    choice = { cliId, modelId: null, effort: null };
  }

  const cliId = choice?.cliId ?? null;
  const profile = cliId ? runProfileForTargetAI(cliId) : null;
  const models = profile && !profile.generic ? profile.models : [];
  const model = models.find((entry) => entry.id === choice?.modelId);
  const efforts = model?.efforts ?? [];
  const effort = choice?.effort && efforts.includes(choice.effort) ? choice.effort : null;
  const cliName = cliId ? (getCliDefinition(cliId)?.name ?? cliId) : 'No planner';
  const label = !choice
    ? 'Detecting CLIs…'
    : [cliName, model?.label ?? 'CLI default model', effort ? EFFORT_LABELS[effort] : null]
        .filter(Boolean)
        .join(' · ');

  return {
    choice,
    detecting,
    clis,
    models,
    model,
    efforts,
    effort,
    label,
    cliName,
    input: { cliId, model: model?.id ?? null, effort },
    selectCli: (next) => setChoice({ cliId: next, modelId: null, effort: null }),
    selectModel: (modelId) => {
      const next = models.find((entry) => entry.id === modelId);
      setChoice({
        cliId,
        modelId: next?.id ?? null,
        effort: next ? (defaultEffortFor(next) ?? null) : null,
      });
    },
    selectEffort: (next) => setChoice({ cliId, modelId: choice?.modelId ?? null, effort: next }),
  };
}

function FieldLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>;
}

/** The planner's CLI, model and effort, side by side. */
export function RelayPlannerFields({
  planner,
  disabled = false,
}: {
  planner: RelayPlanner;
  disabled?: boolean;
}): React.JSX.Element {
  const { choice, detecting, clis, models, model, efforts, effort } = planner;
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>Planned by</FieldLabel>
          <Combobox
            ariaLabel="Planned by"
            className="h-8 text-xs"
            value={choice?.cliId ?? ''}
            onChange={(value) => planner.selectCli(value)}
            disabled={disabled || detecting || clis.length === 0}
            placeholder={detecting ? 'Detecting…' : 'Choose a CLI'}
            searchPlaceholder="Search CLIs…"
            options={clis.map((cli) => ({
              value: cli.id,
              label: cli.name,
              icon: <CliLogo cliId={cli.id} className="h-3.5 w-3.5 shrink-0" />,
            }))}
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Model</FieldLabel>
          <Combobox
            ariaLabel="Planner model"
            className="h-8 text-xs"
            value={model?.id ?? CLI_DEFAULT_MODEL}
            onChange={(value) => planner.selectModel(value === CLI_DEFAULT_MODEL ? null : value)}
            disabled={disabled || models.length === 0}
            placeholder="CLI default"
            searchPlaceholder="Search models…"
            options={[
              { value: CLI_DEFAULT_MODEL, label: 'CLI default' },
              ...models.map((entry) => ({
                value: entry.id,
                label: `${entry.label} · ${entry.tier}`,
                keywords: [entry.bestFor],
              })),
            ]}
          />
        </div>
      </div>
      {efforts.length > 0 ? (
        <div
          role="radiogroup"
          aria-label="Planner effort"
          className="field-surface flex h-8 w-full items-stretch gap-0.5 rounded-full p-0.5"
        >
          {[null, ...efforts].map((level) => {
            const selected = effort === level;
            return (
              <button
                key={level ?? 'auto'}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={level ? EFFORT_LABELS[level] : 'Auto'}
                disabled={disabled}
                onClick={() => planner.selectEffort(level)}
                className={cn(
                  'min-w-0 flex-1 cursor-pointer truncate rounded-full px-1.5 text-xs transition-colors',
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
      ) : null}
      {!detecting && clis.length === 0 ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Planning needs an agent CLI that can answer one prompt, such as Claude Code, Codex or
          Gemini. Install one from CLI Manager.
        </p>
      ) : null}
    </div>
  );
}
