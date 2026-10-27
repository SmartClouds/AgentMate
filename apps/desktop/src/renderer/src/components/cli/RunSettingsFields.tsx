import {
  type CliLaunchOptions,
  cliLaunchOptions,
  EFFORT_LABELS,
  type EffortLevel,
  getCliDefinition,
} from '@runova/core';
import { cliOptionIcon } from '@/components/cliLogos';
import { Combobox } from '@/components/ui/combobox';
import { useAgentChoices } from '@/components/workspace/useAgentChoices';
import { cn } from '@/lib/utils';

export const SHORT_EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

/**
 * Segmented "Not set / Low / … / Max" control. Levels the chosen model can't use are disabled,
 * and the whole control dims when the model has no effort setting at all.
 */
export function EffortPicker({
  options,
  model,
  value,
  onChange,
}: {
  options: CliLaunchOptions;
  model: string | undefined;
  value: EffortLevel | undefined;
  onChange: (effort: EffortLevel | undefined) => void;
}): React.JSX.Element {
  const knownModel = options.models.find((m) => m.value === model);
  const noEffort = Boolean(knownModel && !knownModel.efforts?.length);
  const fits = (level: EffortLevel): boolean =>
    !knownModel || !!knownModel.efforts?.includes(level);
  const choices: { id: EffortLevel | undefined; label: string }[] = [
    { id: undefined, label: 'Not set' },
    ...options.efforts.map((level) => ({ id: level, label: SHORT_EFFORT_LABELS[level] })),
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Effort"
      className={cn(
        // A segmented control drawn on the shared field surface, so it lines up with the fields beside it.
        'field-surface flex h-9 w-full items-stretch gap-0.5 rounded-full p-0.5',
        noEffort && 'opacity-50',
      )}
    >
      {choices.map((choice) => {
        const selected = value === choice.id;
        const disabled = noEffort || (choice.id !== undefined && !fits(choice.id));
        return (
          <button
            key={choice.id ?? 'unset'}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={choice.id ? EFFORT_LABELS[choice.id] : 'Not set'}
            disabled={disabled}
            onClick={() => onChange(choice.id)}
            className={cn(
              'min-w-0 flex-1 cursor-pointer truncate rounded-full px-1.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-40',
              selected
                ? 'bg-primary/15 font-medium text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)]'
                : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
              choice.id === undefined && !selected && 'text-muted-foreground/80',
            )}
          >
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}

export interface RunSettings {
  cliId?: string;
  model?: string;
  effort?: EffortLevel;
}

/** A model or effort that the newly picked CLI doesn't know is dropped rather than carried over. */
function fitToCli(cliId: string | undefined, settings: RunSettings): RunSettings {
  const options = cliId ? cliLaunchOptions(cliId) : null;
  if (!options) return { cliId };
  const model =
    settings.model &&
    (options.models.length === 0 || options.models.some((m) => m.value === settings.model))
      ? settings.model
      : undefined;
  const effort =
    settings.effort && options.efforts.includes(settings.effort) ? settings.effort : undefined;
  return { cliId, model, effort };
}

function FieldLabel({
  children,
  form,
}: {
  children: React.ReactNode;
  form: boolean;
}): React.JSX.Element {
  return (
    <p
      className={
        form ? 'text-sm font-medium leading-none' : 'text-xs font-medium text-muted-foreground'
      }
    >
      {children}
    </p>
  );
}

/**
 * CLI, model and effort to run a prompt with. Leaving the CLI empty means "whatever is the
 * default when it runs", and model/effort only appear once a CLI with those flags is chosen.
 */
export function RunSettingsFields({
  value,
  onChange,
  defaultCliLabel = 'Default CLI',
  labels = 'quiet',
}: {
  value: RunSettings;
  onChange: (next: RunSettings) => void;
  defaultCliLabel?: string;
  /** `form` labels the fields like the rest of a form around them; `quiet` keeps them small. */
  labels?: 'quiet' | 'form';
}): React.JSX.Element {
  const form = labels === 'form';
  const choices = useAgentChoices(null);
  const options = value.cliId ? cliLaunchOptions(value.cliId) : null;
  const cliOptions = [...choices.installed, ...choices.missing].map(({ cli, installed }) => ({
    value: cli.id,
    label: installed ? cli.name : `${cli.name} (not installed)`,
    icon: cliOptionIcon(cli.id),
  }));
  // A CLI saved on a task that is no longer in the registry still shows by id.
  if (value.cliId && !cliOptions.some((o) => o.value === value.cliId)) {
    cliOptions.push({
      value: value.cliId,
      label: getCliDefinition(value.cliId)?.name ?? value.cliId,
      icon: cliOptionIcon(value.cliId),
    });
  }

  return (
    <div className={cn('grid sm:grid-cols-2', form ? 'gap-x-3 gap-y-4' : 'gap-3')}>
      <div className="space-y-1.5">
        <FieldLabel form={form}>CLI</FieldLabel>
        <Combobox
          ariaLabel="CLI"
          value={value.cliId ?? ''}
          onChange={(next) => onChange(fitToCli(next || undefined, value))}
          options={cliOptions}
          placeholder={defaultCliLabel}
          searchPlaceholder="Search CLIs…"
          emptyText="No matching CLI."
          clearable
        />
      </div>
      <div className="space-y-1.5">
        <FieldLabel form={form}>Model</FieldLabel>
        <Combobox
          ariaLabel="Model"
          value={value.model ?? ''}
          onChange={(next) => onChange({ ...value, model: next.trim() || undefined })}
          options={(options?.models ?? []).map((m) => ({
            value: m.value,
            label: m.label,
            keywords: [m.value],
          }))}
          placeholder={options?.modelFlag ? 'CLI default' : 'Pick a CLI first'}
          searchPlaceholder={
            options?.models.length
              ? 'Search or type a model name…'
              : `Type a model name${options?.modelPlaceholder ? `, e.g. ${options.modelPlaceholder}` : ''}…`
          }
          emptyText="Type a model name to use it."
          customLabel={(text) => `Use "${text}"`}
          disabled={!options?.modelFlag}
          allowCustom
          clearable
        />
      </div>
      {options && options.efforts.length > 0 ? (
        <div className="space-y-1.5 sm:col-span-2">
          <FieldLabel form={form}>Effort</FieldLabel>
          <EffortPicker
            options={options}
            model={value.model}
            value={value.effort}
            onChange={(effort) => onChange({ ...value, effort })}
          />
        </div>
      ) : null}
    </div>
  );
}
