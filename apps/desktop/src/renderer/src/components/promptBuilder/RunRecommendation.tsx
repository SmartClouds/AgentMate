import type { EffortLevel, RunChoice, RunRecommendation } from '@agentmat/core';
import {
  defaultEffortFor,
  EFFORT_LABELS,
  getCliDefinition,
  getModelPrice,
  relativeCostLevel,
  runChoiceArgs,
  runProfileForTargetAI,
} from '@agentmat/core';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CostMeter } from '@/components/cli/CostMeter';
import { CliLogo } from '@/components/cliLogos';
import {
  ArrowDown,
  ArrowUp,
  Bolt,
  Check,
  ChevronDown,
  CircleInfo,
  Copy,
  RefreshCw,
  Sparkles,
  Spinner,
  StopCircle,
  TriangleAlert,
  Undo,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { OVERLAY_MOTION, OVERLAY_SURFACE } from '@/components/ui/overlay';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useCliStore } from '@/stores/cliStore';
import type { RunAnalysisStatus, RunOverride } from '@/stores/promptJobsStore';
import {
  cancelRunAssessment,
  EMPTY_RUN_JOB,
  startRunAssessment,
  usePromptJobsStore,
} from '@/stores/promptJobsStore';

export type { RunAnalysisStatus };

export interface AnalyzeRunOptions {
  /** Text to size. Defaults to the current generated prompt. */
  prompt?: string;
  /** Translations aren't shaped by a prompt type, so the CLI isn't told one. */
  isTranslation?: boolean;
}

export interface RunRecommendationState {
  status: RunAnalysisStatus;
  targetAI: string;
  /** Last successful analysis; kept while a re-analysis runs or after it fails. */
  recommendation: RunRecommendation | null;
  choice: RunChoice | null;
  /** True when the user picked something other than the recommendation. */
  isCustom: boolean;
  /** True when the generated prompt or the target changed after the last analysis. */
  isStale: boolean;
  error: string | null;
  /** The CLI that answered last, or the default one we expect to answer. */
  cliName: string | null;
  canAnalyze: boolean;
  analyze: (options?: AnalyzeRunOptions) => void;
  cancel: () => void;
  selectModel: (modelId: string) => void;
  selectEffort: (effort: EffortLevel) => void;
  reset: () => void;
  /** CLI args for the current choice when it's fresh, e.g. `--model sonnet --effort medium`. */
  args: string[];
}

/**
 * Sizes the generated prompt with the default AI CLI and keeps the resulting model/effort
 * suggestion. Nothing runs on its own: callers trigger analyze() once Generate or Translate
 * has produced text, or the user asks for it from the panel.
 *
 * The run and its result live in the prompt jobs store under `jobKey`, so closing the form or
 * leaving the page doesn't stop a sizing that's already running.
 */
export function useRunRecommendation(input: {
  jobKey: string;
  generated: string;
  promptType: string;
  targetAI: string;
  /** Whether `generated` is a translation, which is sized without a prompt type. */
  isTranslation?: boolean;
}): RunRecommendationState {
  const { jobKey, generated, promptType, targetAI, isTranslation = false } = input;
  const defaultCliId = useCliStore((s) => s.defaultCliId);
  const { status, analysis, error, override } = usePromptJobsStore(
    (s) => s.runs[jobKey] ?? EMPTY_RUN_JOB,
  );
  const patchRun = usePromptJobsStore((s) => s.patchRun);
  const setOverride = (next: RunOverride | null) => patchRun(jobKey, { override: next });

  const cancel = useCallback(() => cancelRunAssessment(jobKey), [jobKey]);

  const analyze = useCallback(
    (options: AnalyzeRunOptions = {}) =>
      startRunAssessment(jobKey, {
        prompt: options.prompt ?? generated,
        targetAI,
        promptType: (options.isTranslation ?? isTranslation) ? undefined : promptType,
      }),
    [jobKey, generated, promptType, targetAI, isTranslation],
  );

  const recommendation = analysis?.recommendation ?? null;
  const overrideModel = override
    ? recommendation?.profile.models.find((m) => m.id === override.modelId)
    : undefined;
  const choice: RunChoice | null = recommendation
    ? overrideModel
      ? {
          model: overrideModel,
          effort:
            override?.effort && overrideModel.efforts?.includes(override.effort)
              ? override.effort
              : defaultEffortFor(overrideModel),
        }
      : recommendation.recommended
    : null;

  const isCustom =
    !!recommendation &&
    !!choice &&
    (choice.model.id !== recommendation.recommended.model.id ||
      choice.effort !== recommendation.recommended.effort);
  const isStale =
    !!analysis &&
    (analysis.prompt !== generated.trim() || analysis.recommendation.targetAI !== targetAI);

  const defaultCliName = defaultCliId ? (getCliDefinition(defaultCliId)?.name ?? null) : null;

  return {
    status,
    targetAI,
    recommendation,
    choice,
    isCustom,
    isStale,
    error,
    cliName: analysis?.cliName ?? defaultCliName,
    canAnalyze: generated.trim().length > 0,
    analyze,
    cancel,
    selectModel: (modelId) => {
      const model = recommendation?.profile.models.find((m) => m.id === modelId);
      if (!model || !recommendation) return;
      const effort =
        modelId === recommendation.recommended.model.id
          ? recommendation.recommended.effort
          : defaultEffortFor(model);
      setOverride({ modelId, effort });
    },
    selectEffort: (effort) => {
      if (choice) setOverride({ modelId: choice.model.id, effort });
    },
    reset: () => setOverride(null),
    args: recommendation && choice && !isStale ? runChoiceArgs(recommendation.profile, choice) : [],
  };
}

/**
 * Whether opening the chip should start a sizing: there is text to size, nothing is being sized
 * right now, and the last result is missing or was made for an older prompt or target.
 */
export function shouldSizeOnOpen(
  state: Pick<RunRecommendationState, 'canAnalyze' | 'status' | 'recommendation' | 'isStale'>,
): boolean {
  return (
    state.canAnalyze && state.status !== 'analyzing' && (!state.recommendation || state.isStale)
  );
}

const COMPLEXITY_COPY = {
  light: { label: 'Light task', className: 'text-success' },
  moderate: { label: 'Moderate task', className: 'text-warning' },
  complex: { label: 'Complex task', className: 'text-destructive' },
} as const;

const COST_COPY = ['Lowest cost', 'Low cost', 'Moderate cost', 'High cost', 'Highest cost'];

function formatPrice(value: number): string {
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

const sectionLabelClass = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
const quietButtonClass =
  'inline-flex items-center gap-1 rounded px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function readCollapsed(storageKey: string | undefined): boolean {
  if (!storageKey) return false;
  try {
    return localStorage.getItem(storageKey) === '1';
  } catch {
    return false;
  }
}

export function RunRecommendationPanel({
  state,
  className,
  collapsibleKey,
  sizeOnOpen = false,
}: {
  state: RunRecommendationState;
  className?: string;
  /**
   * Makes the panel foldable down to its header, remembering the choice under this
   * localStorage key. For layouts where the details would crowd out the prompt editor.
   */
  collapsibleKey?: string;
  /** The chip sizes on open, so the empty state should not promise sizing on Generate. */
  sizeOnOpen?: boolean;
}): React.JSX.Element {
  const { status, recommendation, targetAI, cliName, canAnalyze, isStale, choice } = state;
  const [collapsed, setCollapsed] = useState(() => readCollapsed(collapsibleKey));

  function toggleCollapsed(): void {
    setCollapsed((current) => {
      const next = !current;
      try {
        if (collapsibleKey) localStorage.setItem(collapsibleKey, next ? '1' : '0');
      } catch {
        // Remembering the fold is a nicety; the panel still works without storage.
      }
      return next;
    });
  }

  const profile = recommendation?.profile ?? runProfileForTargetAI(targetAI);
  const cliLabel = cliName ?? 'your default AI CLI';
  const analyzing = status === 'analyzing';
  const complexity = recommendation ? COMPLEXITY_COPY[recommendation.assessment.complexity] : null;

  let subtitle: string;
  if (analyzing) subtitle = `Sizing the generated prompt with ${cliLabel}…`;
  else if (recommendation && collapsed && choice)
    subtitle = [
      choice.model.label,
      choice.effort && `${EFFORT_LABELS[choice.effort]} effort`,
      isStale && 'prompt changed since',
    ]
      .filter(Boolean)
      .join(' · ');
  else if (recommendation) subtitle = `Sized by ${cliLabel} for ${recommendation.targetAI}`;
  else if (status === 'error' && collapsed) subtitle = 'Sizing failed. Expand to retry.';
  else subtitle = `Model and effort for ${targetAI}, sized by ${cliLabel}`;

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background/60">
            {profile.cliId ? (
              <CliLogo cliId={profile.cliId} className="h-3.5 w-3.5" />
            ) : (
              <Bolt className="h-3.5 w-3.5 text-primary" />
            )}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium leading-tight">Recommended run</div>
            <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {analyzing ? (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1.5 px-2"
            onClick={state.cancel}
          >
            <StopCircle className="h-3 w-3" /> Stop
          </Button>
        ) : recommendation && complexity ? (
          <div className="flex shrink-0 items-start gap-2">
            <div className="flex flex-col items-end gap-1">
              <span className={cn('text-[11px] font-medium', complexity.className)}>
                {complexity.label}
              </span>
              <span
                className="h-1 w-20 overflow-hidden rounded-full bg-foreground/10"
                role="meter"
                aria-label="Task complexity"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={recommendation.assessment.score}
              >
                <span
                  className="block h-full rounded-full bg-gradient-to-r from-success via-warning to-destructive transition-[width] duration-300"
                  style={{ width: `${Math.max(6, recommendation.assessment.score)}%` }}
                />
              </span>
            </div>
            <SimpleTooltip label={canAnalyze ? 'Size the prompt again' : 'Nothing to size'}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={!canAnalyze}
                onClick={() => state.analyze()}
                className="disabled:opacity-40"
              >
                <RefreshCw className="h-3 w-3" />
                <span className="sr-only">Size the prompt again</span>
              </Button>
            </SimpleTooltip>
          </div>
        ) : null}
        {collapsibleKey && (
          <SimpleTooltip label={collapsed ? 'Show details' : 'Hide details'}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-expanded={!collapsed}
              onClick={toggleCollapsed}
              className="shrink-0"
            >
              <ChevronDown
                className={cn('h-3 w-3 transition-transform', !collapsed && 'rotate-180')}
              />
              <span className="sr-only">{collapsed ? 'Show details' : 'Hide details'}</span>
            </Button>
          </SimpleTooltip>
        )}
      </div>

      {collapsed ? null : analyzing ? (
        <RunSkeleton columns={profile.models.length} />
      ) : status === 'error' && !recommendation ? (
        <RunError state={state} />
      ) : recommendation ? (
        <>
          {status === 'error' && <RunError state={state} compact />}
          {isStale && status !== 'error' && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
              <span className="flex min-w-0 items-center gap-1.5">
                <TriangleAlert className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {recommendation.targetAI !== targetAI
                    ? `Target changed to ${targetAI} since this was sized.`
                    : 'The generated prompt changed since this was sized.'}
                </span>
              </span>
              <button
                type="button"
                disabled={!canAnalyze}
                onClick={() => state.analyze()}
                className="shrink-0 rounded px-1 font-medium underline-offset-2 hover:underline disabled:opacity-50"
              >
                Size again
              </button>
            </div>
          )}
          <RunResult state={state} recommendation={recommendation} />
        </>
      ) : (
        <RunEmpty state={state} sizeOnOpen={sizeOnOpen} />
      )}
    </div>
  );
}

function RunEmpty({
  state,
  sizeOnOpen = false,
}: {
  state: RunRecommendationState;
  sizeOnOpen?: boolean;
}): React.JSX.Element {
  const cliLabel = state.cliName ?? 'your default AI CLI';
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-center">
      <Sparkles className="h-4 w-4 text-primary" />
      <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">
        {state.canAnalyze
          ? `Ask ${cliLabel} how big this prompt is and which model and effort will do it without overspending.`
          : sizeOnOpen
            ? `Generate or translate a prompt first. Then ${cliLabel} sizes it when you open this.`
            : `Generate or translate a prompt first. ${cliLabel[0]?.toUpperCase()}${cliLabel.slice(1)} then sizes it and suggests a model and effort.`}
      </p>
      <Button
        size="sm"
        variant="soft"
        className="gap-1.5 px-2.5"
        disabled={!state.canAnalyze}
        onClick={() => state.analyze()}
      >
        <Bolt className="h-3 w-3" /> Size this prompt
      </Button>
    </div>
  );
}

function RunError({
  state,
  compact = false,
}: {
  state: RunRecommendationState;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 text-[11px] text-destructive',
        compact ? 'items-center justify-between px-2 py-1.5' : 'flex-col items-start px-3 py-2.5',
      )}
    >
      <span className={cn('flex min-w-0 gap-1.5', compact ? 'items-center' : 'items-start')}>
        <TriangleAlert className={cn('h-3 w-3 shrink-0', !compact && 'mt-px')} />
        <span className={cn(compact && 'truncate')}>{state.error}</span>
      </span>
      <button
        type="button"
        disabled={!state.canAnalyze}
        onClick={() => state.analyze()}
        className="inline-flex shrink-0 items-center gap-1 rounded font-medium underline-offset-2 hover:underline disabled:opacity-50"
      >
        <RefreshCw className="h-2.5 w-2.5" /> Try again
      </button>
    </div>
  );
}

function RunSkeleton({ columns }: { columns: number }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-12" />
        <div
          className="grid gap-1.5"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }, (_, i) => (
            <Skeleton key={i} className="h-[3.9rem] rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-7 rounded-lg" />
      </div>
      <Skeleton className="h-[3.6rem] rounded-lg" />
    </div>
  );
}

function RunResult({
  state,
  recommendation,
}: {
  state: RunRecommendationState;
  recommendation: RunRecommendation;
}): React.JSX.Element | null {
  const { choice, isStale, selectModel, selectEffort, reset, args } = state;
  const { profile, assessment, recommended } = recommendation;
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  if (!choice) return null;

  // Each section offers the reset when its own pick differs. Reset always puts back both.
  const modelChanged = choice.model.id !== recommended.model.id;
  const effortChanged = choice.effort !== recommended.effort;
  const costLevel = relativeCostLevel(profile, choice);
  const price = choice.model.pricingId ? getModelPrice(choice.model.pricingId) : null;
  // While stale the hook withholds args (so Send to CLI won't use them), but the command
  // stays readable here for reference.
  const commandArgs = args.length > 0 ? args : runChoiceArgs(profile, choice);
  const command = [profile.executable, ...commandArgs].filter(Boolean).join(' ');

  async function copyCommand(): Promise<void> {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className={cn('space-y-3 transition-opacity', isStale && 'opacity-60')}>
      {assessment.summary && (
        <p className="text-xs leading-relaxed text-foreground/90">{assessment.summary}</p>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className={sectionLabelClass}>Model</span>
          {modelChanged && (
            <button type="button" onClick={reset} className={quietButtonClass}>
              <Undo className="h-2.5 w-2.5" /> Use recommended
            </button>
          )}
        </div>
        <div
          role="radiogroup"
          aria-label="Model"
          className="grid gap-1.5"
          style={{ gridTemplateColumns: `repeat(${profile.models.length}, minmax(0, 1fr))` }}
        >
          {profile.models.map((model) => {
            const selected = model.id === choice.model.id;
            const isRecommended = model.id === recommended.model.id;
            const level = relativeCostLevel(profile, {
              model,
              effort: isRecommended ? recommended.effort : defaultEffortFor(model),
            });
            return (
              <button
                key={model.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => selectModel(model.id)}
                className={cn(
                  'relative flex min-w-0 flex-col items-start gap-1 rounded-lg border px-2 py-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'border-primary/60 bg-primary/10 shadow-[0_0_14px_-6px_hsl(var(--primary)/0.6)]'
                    : 'border-border bg-background/40 hover:border-foreground/20 hover:bg-accent/50',
                )}
              >
                <span className="flex w-full items-center justify-between gap-1">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {model.tier}
                  </span>
                  {isRecommended && (
                    <SimpleTooltip label="Recommended for this prompt">
                      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="h-2 w-2" />
                      </span>
                    </SimpleTooltip>
                  )}
                </span>
                <span className="w-full truncate text-xs font-semibold">{model.label}</span>
                <CostMeter level={level} />
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">{choice.model.bestFor}.</p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className={sectionLabelClass}>Effort</span>
          {effortChanged && (
            <button type="button" onClick={reset} className={quietButtonClass}>
              <Undo className="h-2.5 w-2.5" /> Use recommended
            </button>
          )}
        </div>
        {choice.model.efforts?.length ? (
          <div
            role="radiogroup"
            aria-label="Effort"
            className="flex rounded-lg border border-border bg-background/40 p-0.5"
          >
            {choice.model.efforts.map((level) => {
              const selected = level === choice.effort;
              const isRecommended =
                choice.model.id === recommended.model.id && level === recommended.effort;
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => selectEffort(level)}
                  className={cn(
                    'relative flex-1 whitespace-nowrap rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {EFFORT_LABELS[level]}
                  {isRecommended && !selected && (
                    <span className="absolute right-1 top-1 h-1 w-1 rounded-full bg-primary" />
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="flex items-start gap-1.5 rounded-lg border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground">
            <CircleInfo className="mt-px h-3 w-3 shrink-0" />
            {profile.effortHint}
          </p>
        )}
      </div>

      {assessment.signals.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-0.5 text-[11px] text-muted-foreground">Why</span>
          {assessment.signals.map((signal) => (
            <span
              key={signal.label}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px]',
                signal.direction === 'up'
                  ? 'border-warning/30 bg-warning/10 text-warning'
                  : 'border-success/30 bg-success/10 text-success',
              )}
            >
              {signal.direction === 'up' ? (
                <ArrowUp className="h-2 w-2" />
              ) : (
                <ArrowDown className="h-2 w-2" />
              )}
              {signal.label}
            </span>
          ))}
        </div>
      )}

      <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-2">
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="flex items-center gap-1.5">
            <CostMeter level={costLevel} />
            <span className="font-medium">{COST_COPY[costLevel - 1]}</span>
            <span className="text-muted-foreground">for {recommendation.targetAI}</span>
          </span>
          {price && (
            <span className="tabular-nums text-muted-foreground">
              {formatPrice(price.input)} in · {formatPrice(price.output)} out / 1M
            </span>
          )}
        </div>
        {commandArgs.length > 0 && (
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded-md bg-background/70 px-2 py-1 font-mono text-[11px]">
              {command}
            </code>
            <SimpleTooltip label={copied ? 'Copied' : 'Copy command'}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => void copyCommand()}
                className="shrink-0"
              >
                {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
                <span className="sr-only">Copy command</span>
              </Button>
            </SimpleTooltip>
          </div>
        )}
        {profile.note && <p className="text-[11px] text-muted-foreground">{profile.note}</p>}
      </div>
    </div>
  );
}

/** One-line summary for tight layouts; the full panel opens in a popover. */
export function RunRecommendationChip({
  state,
  className,
  sizeOnOpen = false,
}: {
  state: RunRecommendationState;
  className?: string;
  /**
   * Starts sizing when the chip opens, if the prompt has no current result. For forms that leave
   * sizing to the user instead of sizing after every Generate or Translate.
   */
  sizeOnOpen?: boolean;
}): React.JSX.Element {
  const { status, recommendation, choice, isCustom, isStale } = state;

  let body: React.ReactNode;
  let tooltip: string;
  if (status === 'analyzing') {
    body = (
      <>
        <Spinner className="h-3 w-3 shrink-0 animate-spin text-primary" />
        <span className="truncate text-muted-foreground">Sizing…</span>
      </>
    );
    tooltip = `Sizing the prompt with ${state.cliName ?? 'your default AI CLI'}`;
  } else if (recommendation && choice) {
    body = (
      <>
        {isStale ? (
          <TriangleAlert className="h-3 w-3 shrink-0 text-warning" />
        ) : (
          <Bolt
            className={cn('h-3 w-3 shrink-0', isCustom ? 'text-muted-foreground' : 'text-primary')}
          />
        )}
        <span className="truncate font-medium">{choice.model.label}</span>
        {/* In a tight row the effort gives way first, so the model name stays readable. Shrink is
            weighted by width, so a small factor would still clip the name alongside it. */}
        {choice.effort && (
          <span className="shrink-[100] truncate text-muted-foreground">
            {EFFORT_LABELS[choice.effort]}
          </span>
        )}
        <CostMeter level={relativeCostLevel(recommendation.profile, choice)} className="shrink-0" />
      </>
    );
    tooltip = isStale
      ? 'The prompt changed since it was sized'
      : 'Which model and effort to run this with';
  } else if (status === 'error') {
    body = (
      <>
        <TriangleAlert className="h-3 w-3 shrink-0 text-destructive" />
        <span className="truncate text-destructive">Sizing failed</span>
      </>
    );
    tooltip = state.error ?? 'Sizing failed';
  } else {
    body = (
      <>
        <Bolt className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="truncate text-muted-foreground">Size run</span>
      </>
    );
    tooltip = state.canAnalyze
      ? 'Ask your default AI CLI which model and effort this needs'
      : sizeOnOpen
        ? 'Generate or translate a prompt, then open this to size it'
        : 'Generate or translate a prompt, then it gets sized';
  }

  return (
    <PopoverPrimitive.Root
      onOpenChange={(open) => {
        if (open && sizeOnOpen && shouldSizeOnOpen(state)) state.analyze();
      }}
    >
      <SimpleTooltip label={tooltip}>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            className={cn(
              'field-surface flex h-7 min-w-0 items-center gap-1 rounded-full pl-2.5 pr-2 text-xs focus:outline-none',
              className,
            )}
          >
            {body}
            <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-50" />
          </button>
        </PopoverPrimitive.Trigger>
      </SimpleTooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            OVERLAY_SURFACE,
            OVERLAY_MOTION,
            'z-50 w-[min(27rem,calc(100vw-2rem))] p-3 origin-[var(--radix-popover-content-transform-origin)]',
          )}
        >
          <RunRecommendationPanel state={state} sizeOnOpen={sizeOnOpen} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
