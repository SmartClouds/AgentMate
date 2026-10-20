import { z } from 'zod';
import { cliIdForTargetAI, getCliDefinition } from '../cli/registry.js';
import {
  type CatalogModel,
  CLAUDE_MODELS,
  CODEX_MODELS,
  GEMINI_CLI_MODELS,
} from '../models/catalog.js';

/**
 * Suggests which model and reasoning effort to run a generated prompt with, so the result
 * is good enough without paying for a bigger model than the task needs.
 *
 * The sizing itself comes from the user's default AI CLI: once Prompt Builder has produced
 * a prompt (or a translation), buildRunAssessmentPrompt() asks that CLI to score it against
 * the target's own model list, and parseRunAssessment() turns its answer into plain data.
 * Everything else here (model catalog, CLI flags, relative cost) is local.
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** Rough spend multiplier per effort level, relative to `high`. */
const EFFORT_COST_FACTOR: Record<EffortLevel, number> = {
  low: 0.5,
  medium: 0.75,
  high: 1,
  xhigh: 1.4,
  max: 2,
};

export type TaskComplexity = 'light' | 'moderate' | 'complex';

export interface TaskSignal {
  label: string;
  /** Whether this signal pushed the recommendation toward a bigger or a smaller run. */
  direction: 'up' | 'down';
}

/**
 * How the default AI CLI sized a generated prompt. Plain data on purpose: it crosses IPC
 * from the main process, and the renderer rebuilds the profile (which carries functions)
 * on its own side.
 */
export interface RunAssessment {
  /** 0 (trivial) to 100 (hardest). */
  score: number;
  complexity: TaskComplexity;
  signals: TaskSignal[];
  /** One sentence on what drives the size. */
  summary: string;
  /** Model id from the target's profile. */
  modelId: string;
  effort: EffortLevel | undefined;
}

export interface RunModelOption {
  /** Stable key within a profile, and the id the CLI is asked to answer with. */
  id: string;
  label: string;
  /** Short tier name shown above the model, e.g. "Fast". */
  tier: string;
  /** Value passed to the CLI's model flag. Absent for provider-agnostic CLIs. */
  modelArg?: string;
  /** Model id to look up in the usage price map. */
  pricingId?: string;
  /** Relative spend of this model against the others, 1 being the cheapest. */
  costWeight: number;
  bestFor: string;
  /**
   * Highest task score this model is the cheapest good fit for. Only used to place a
   * score when the CLI names a model this profile doesn't have.
   */
  maxScore: number;
  /** Effort levels this model accepts, lowest first. Absent when effort can't be set. */
  efforts?: readonly EffortLevel[];
  /** Effort to suggest for the lower, middle, and upper third of this model's score band. */
  effortPicks?: readonly [EffortLevel, EffortLevel, EffortLevel];
}

export interface TargetRunProfile {
  cliId: string | undefined;
  /** True when the CLI runs against a provider we can't know, so models are described by class. */
  generic: boolean;
  executable: string | undefined;
  modelFlag?: string;
  effortArgs?: (level: EffortLevel) => string[];
  /** Shown instead of effort controls when the selected model has no effort setting. */
  effortHint: string;
  note?: string;
  models: readonly RunModelOption[];
}

export interface RunChoice {
  model: RunModelOption;
  effort: EffortLevel | undefined;
}

export interface RunRecommendation {
  targetAI: string;
  profile: TargetRunProfile;
  assessment: RunAssessment;
  recommended: RunChoice;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function complexityForScore(score: number): TaskComplexity {
  if (score < 30) return 'light';
  if (score < 65) return 'moderate';
  return 'complex';
}

/** The names half of a model option, taken from the catalog so a rename is one edit there. */
function fromCatalog(
  id: string,
  model: CatalogModel,
): Pick<RunModelOption, 'id' | 'label' | 'modelArg' | 'pricingId'> {
  return {
    id,
    label: model.label,
    modelArg: model.cliArg,
    ...(model.apiId ? { pricingId: model.apiId } : {}),
  };
}

const CLAUDE_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Hand-maintained per CLI. Model names change often, so only CLIs whose flags and model
 * names we've checked against their docs get a concrete profile; the rest get the generic
 * one, which describes models by class instead of guessing ids.
 */
const RUN_PROFILES: Record<string, Omit<TargetRunProfile, 'cliId' | 'executable'>> = {
  'claude-code': {
    generic: false,
    modelFlag: '--model',
    effortArgs: (level) => ['--effort', level],
    effortHint: 'This model has no effort setting.',
    models: [
      {
        ...fromCatalog('haiku', CLAUDE_MODELS.haiku),
        tier: 'Fast',
        costWeight: 1,
        bestFor: 'Small, well-defined edits and quick lookups',
        maxScore: 22,
        efforts: CLAUDE_EFFORTS,
        effortPicks: ['low', 'low', 'medium'],
      },
      {
        ...fromCatalog('sonnet', CLAUDE_MODELS.sonnet),
        tier: 'Balanced',
        costWeight: 3,
        bestFor: 'Everyday features, fixes, and tests',
        maxScore: 60,
        efforts: CLAUDE_EFFORTS,
        effortPicks: ['low', 'medium', 'high'],
      },
      {
        ...fromCatalog('opus', CLAUDE_MODELS.opus),
        tier: 'Deep',
        costWeight: 4,
        bestFor: 'Multi-file refactors and tricky systems work',
        maxScore: 86,
        efforts: CLAUDE_EFFORTS,
        effortPicks: ['medium', 'high', 'xhigh'],
      },
      {
        ...fromCatalog('fable', CLAUDE_MODELS.fable),
        tier: 'Frontier',
        costWeight: 10,
        bestFor: 'Long, demanding agent sessions and hard reasoning',
        maxScore: 100,
        efforts: CLAUDE_EFFORTS,
        effortPicks: ['high', 'high', 'xhigh'],
      },
    ],
  },
  'codex-cli': {
    generic: false,
    modelFlag: '--model',
    effortArgs: (level) => ['-c', `model_reasoning_effort=${level}`],
    effortHint: 'This model has no effort setting.',
    models: [
      {
        ...fromCatalog('luna', CODEX_MODELS.luna),
        tier: 'Fast',
        costWeight: 1,
        bestFor: 'Small, well-defined edits',
        maxScore: 30,
        efforts: CODEX_EFFORTS,
        effortPicks: ['low', 'low', 'medium'],
      },
      {
        ...fromCatalog('sol', CODEX_MODELS.sol),
        tier: 'Balanced',
        costWeight: 3,
        bestFor: 'Everyday features, fixes, and tests',
        maxScore: 65,
        efforts: CODEX_EFFORTS,
        effortPicks: ['medium', 'medium', 'high'],
      },
      {
        ...fromCatalog('astra', CODEX_MODELS.astra),
        tier: 'Deep',
        costWeight: 6,
        bestFor: 'Complex, multi-step engineering work',
        maxScore: 100,
        efforts: CODEX_EFFORTS,
        effortPicks: ['high', 'high', 'xhigh'],
      },
    ],
  },
  'gemini-cli': {
    generic: false,
    modelFlag: '--model',
    effortHint:
      'Gemini CLI has no per-run effort flag. Its thinking budget lives in settings.json (thinkingConfig).',
    models: [
      {
        ...fromCatalog('flash-lite', GEMINI_CLI_MODELS.flashLite),
        tier: 'Fast',
        costWeight: 1,
        bestFor: 'Small, well-defined edits',
        maxScore: 30,
      },
      {
        ...fromCatalog('flash', GEMINI_CLI_MODELS.flash),
        tier: 'Balanced',
        costWeight: 2,
        bestFor: 'Everyday features, fixes, and tests',
        maxScore: 65,
      },
      {
        ...fromCatalog('pro', GEMINI_CLI_MODELS.pro),
        tier: 'Deep',
        costWeight: 6,
        bestFor: 'Complex reasoning and larger changes',
        maxScore: 86,
      },
      {
        ...fromCatalog('argon', GEMINI_CLI_MODELS.argon),
        tier: 'Frontier',
        costWeight: 8,
        bestFor: 'The hardest reasoning and long agent sessions',
        maxScore: 100,
      },
    ],
  },
};

const GENERIC_MODELS: readonly RunModelOption[] = [
  {
    id: 'fast',
    label: 'Small model',
    tier: 'Fast',
    costWeight: 1,
    bestFor: `A ${CLAUDE_MODELS.haiku.family}, Flash, or mini class model for small edits`,
    maxScore: 30,
  },
  {
    id: 'balanced',
    label: 'Mid-tier model',
    tier: 'Balanced',
    costWeight: 3,
    bestFor: `A ${CLAUDE_MODELS.sonnet.family} class model for everyday coding`,
    maxScore: 65,
  },
  {
    id: 'frontier',
    label: 'Frontier model',
    tier: 'Deep',
    costWeight: 6,
    bestFor: `An ${CLAUDE_MODELS.opus.family} or Pro class model for complex work`,
    maxScore: 100,
  },
];

export function runProfileForTargetAI(targetAI: string): TargetRunProfile {
  const cliId = cliIdForTargetAI(targetAI);
  const cli = cliId ? getCliDefinition(cliId) : undefined;
  const executable = cli?.executableNames[0];
  const known = cliId ? RUN_PROFILES[cliId] : undefined;
  if (known) return { ...known, cliId, executable };

  // The example args already name each CLI's real model flag (`--model`, `-m`, ...).
  const exampleFlag = cli?.argsExample?.split(/\s+/)[0];
  const modelFlag =
    exampleFlag && /^-/.test(exampleFlag) && /model|^-m$/.test(exampleFlag)
      ? exampleFlag
      : undefined;
  return {
    cliId,
    executable,
    generic: true,
    modelFlag,
    effortHint: 'If your provider has a reasoning effort setting, set it there.',
    note: `${cli?.label ?? targetAI} runs whichever provider you set up, so pick the matching model from it.`,
    models: GENERIC_MODELS,
  };
}

function effortForBand(model: RunModelOption, band: 0 | 1 | 2): EffortLevel | undefined {
  if (!model.efforts?.length) return undefined;
  return model.effortPicks?.[band] ?? model.efforts[Math.floor(model.efforts.length / 2)];
}

/** The effort to show when the user switches to a model without a score to place it by. */
export function defaultEffortFor(model: RunModelOption): EffortLevel | undefined {
  return effortForBand(model, 1);
}

function bandFor(profile: TargetRunProfile, model: RunModelOption, score: number): 0 | 1 | 2 {
  const index = profile.models.indexOf(model);
  const floor = index > 0 ? (profile.models[index - 1]?.maxScore ?? 0) : 0;
  const position = (score - floor) / Math.max(1, model.maxScore - floor);
  return position < 1 / 3 ? 0 : position < 2 / 3 ? 1 : 2;
}

/** The cheapest model whose band covers `score`, for answers that name no usable model. */
function modelForScore(profile: TargetRunProfile, score: number): RunModelOption {
  return (
    profile.models.find((m) => score <= m.maxScore) ?? profile.models[profile.models.length - 1]!
  );
}

/** Generated prompts can be long; the size of the task shows well before the end of it. */
const MAX_ASSESSED_PROMPT_CHARS = 12000;

function describeModels(profile: TargetRunProfile): string {
  return profile.models
    .map((m) => {
      const effort = m.efforts?.length
        ? `effort levels: ${m.efforts.join(', ')}`
        : 'no effort setting (use null)';
      return `- "${m.id}": ${m.label} (${m.tier} tier). ${m.bestFor}. ${effort}.`;
    })
    .join('\n');
}

/**
 * The instruction sent to the default AI CLI. It asks for JSON only and forbids tools, so a
 * coding agent answers in one round-trip instead of wandering off to explore a repository.
 */
export function buildRunAssessmentPrompt(input: {
  prompt: string;
  targetAI: string;
  promptType?: string;
}): string {
  const profile = runProfileForTargetAI(input.targetAI);
  const text =
    input.prompt.length > MAX_ASSESSED_PROMPT_CHARS
      ? `${input.prompt.slice(0, MAX_ASSESSED_PROMPT_CHARS)}\n[prompt truncated]`
      : input.prompt;
  const typeLine = input.promptType ? `Prompt type: ${input.promptType}\n` : '';

  return [
    'You are sizing a software task so the user can run it with the cheapest model and the',
    'lowest reasoning effort that will still do it well. Do not use any tools, do not read or',
    'edit files, and do not carry out the task. Only assess it.',
    '',
    `Target agent: ${input.targetAI}`,
    `${typeLine}Models available for this agent, cheapest first:`,
    describeModels(profile),
    '',
    'Scoring guide:',
    '- 0 to 29: light. One small, well-understood change.',
    '- 30 to 64: moderate. A normal feature or fix touching a few files.',
    '- 65 to 100: complex. Cross-cutting, risky, or needs investigation and design first.',
    'Pick the cheapest model and the lowest effort that would still complete the task reliably.',
    'Only move up when the task clearly needs it.',
    '',
    'Task prompt:',
    '<<<',
    text,
    '>>>',
    '',
    'Reply with a single JSON object and nothing else, in English, shaped like this:',
    '{"score": <whole number from 0 to 100>, "model": "<one model id from the list>", "effort": "<one of that model\'s effort levels, or null>", "summary": "<one sentence on what drives the size>", "reasons": [{"label": "<two to five words>", "direction": "up"}, {"label": "<two to five words>", "direction": "down"}]}',
    'Give two to four reasons. "up" means the reason calls for a bigger run, "down" a smaller one.',
  ].join('\n');
}

const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const AssessmentAnswerSchema = z.object({
  score: z.coerce.number(),
  model: z.string().optional(),
  effort: z.string().nullish(),
  summary: z.string().optional(),
  reasons: z
    .array(
      z.object({
        label: z.string(),
        direction: z.string().optional(),
      }),
    )
    .optional(),
});

/** Pulls the JSON object out of an answer that may be wrapped in a code fence or prose. */
function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Validates the CLI's answer against the target's profile. A model id the profile doesn't
 * know falls back to the model that fits the score, and an effort that model doesn't accept
 * falls back to its usual pick, so a slightly-off answer still yields a usable run.
 * Returns null when there's no score to go on at all.
 */
export function parseRunAssessment(text: string, targetAI: string): RunAssessment | null {
  const parsed = AssessmentAnswerSchema.safeParse(extractJsonObject(text));
  if (!parsed.success || !Number.isFinite(parsed.data.score)) return null;
  const answer = parsed.data;
  const profile = runProfileForTargetAI(targetAI);
  const score = clamp(Math.round(answer.score), 0, 100);

  const wanted = answer.model?.trim().toLowerCase();
  const model =
    profile.models.find((m) => m.id.toLowerCase() === wanted) ??
    profile.models.find((m) => wanted && m.label.toLowerCase() === wanted) ??
    modelForScore(profile, score);

  const effortAnswer = answer.effort?.trim().toLowerCase();
  const effort =
    effortAnswer &&
    (EFFORT_VALUES as readonly string[]).includes(effortAnswer) &&
    model.efforts?.includes(effortAnswer as EffortLevel)
      ? (effortAnswer as EffortLevel)
      : effortForBand(model, bandFor(profile, model, score));

  const signals: TaskSignal[] = (answer.reasons ?? [])
    .map((r) => ({
      label: r.label.trim().slice(0, 48),
      direction: r.direction?.trim().toLowerCase() === 'down' ? ('down' as const) : ('up' as const),
    }))
    .filter((r) => r.label)
    .slice(0, 4);

  return {
    score,
    complexity: complexityForScore(score),
    signals,
    summary: answer.summary?.trim() ?? '',
    modelId: model.id,
    effort,
  };
}

/** Rebuilds the full recommendation (profile included) from an assessment that crossed IPC. */
export function recommendationFromAssessment(
  targetAI: string,
  assessment: RunAssessment,
): RunRecommendation {
  const profile = runProfileForTargetAI(targetAI);
  const model =
    profile.models.find((m) => m.id === assessment.modelId) ??
    modelForScore(profile, assessment.score);
  const effort =
    assessment.effort && model.efforts?.includes(assessment.effort)
      ? assessment.effort
      : effortForBand(model, bandFor(profile, model, assessment.score));
  return { targetAI, profile, assessment, recommended: { model, effort } };
}

/** CLI args that apply a choice, e.g. `['--model', 'sonnet', '--effort', 'medium']`. */
export function runChoiceArgs(profile: TargetRunProfile, choice: RunChoice): string[] {
  const args: string[] = [];
  if (profile.modelFlag && choice.model.modelArg)
    args.push(profile.modelFlag, choice.model.modelArg);
  if (choice.effort && profile.effortArgs && choice.model.efforts?.includes(choice.effort)) {
    args.push(...profile.effortArgs(choice.effort));
  }
  return args;
}

/**
 * Model and effort flags for a CLI the user picked by hand, or none when no model was picked
 * (the CLI then runs on its own defaults) or the model isn't one this CLI's profile knows.
 */
export function runArgsFor(
  cliId: string | null | undefined,
  modelId: string | null | undefined,
  effort: EffortLevel | null | undefined,
): string[] {
  if (!cliId || !modelId) return [];
  const profile = runProfileForTargetAI(cliId);
  const model = profile.models.find((m) => m.id === modelId);
  return model ? runChoiceArgs(profile, { model, effort: effort ?? undefined }) : [];
}

function matchReportedModel(
  profile: TargetRunProfile,
  rawModel: string,
): RunModelOption | undefined {
  const lower = rawModel.toLowerCase();
  return (
    profile.models.find((m) => m.modelArg && lower === m.modelArg.toLowerCase()) ??
    profile.models.find((m) => m.modelArg && lower.includes(m.modelArg.toLowerCase())) ??
    profile.models.find((m) => lower.includes(m.id.toLowerCase()))
  );
}

/**
 * Turns a model and effort a CLI actually reported (say, from a hook after a `/model` switch)
 * into the flags that would start a fresh run the same way. Lets a new tab for that CLI open
 * on what the user was last really running it on, instead of a default computed elsewhere.
 */
export function runArgsFromReported(
  cliId: string,
  reported: { model?: string; effort?: string },
): string[] {
  const rawModel = reported.model?.trim();
  if (!rawModel) return [];
  const profile = runProfileForTargetAI(cliId);
  const model = matchReportedModel(profile, rawModel);
  if (!model) return [];
  const effortRaw = reported.effort?.trim().toLowerCase();
  const effort =
    effortRaw &&
    (EFFORT_VALUES as readonly string[]).includes(effortRaw) &&
    model.efforts?.includes(effortRaw as EffortLevel)
      ? (effortRaw as EffortLevel)
      : undefined;
  return runChoiceArgs(profile, { model, effort });
}

/** Short spellings CLIs accept for the long flags run args use. */
const RUN_FLAG_ALIASES: Record<string, readonly string[]> = {
  '--model': ['-m'],
};

/**
 * Drops whatever the user's own CLI arguments set that the run args also set, for runs where the
 * model and effort were picked on purpose (say, in a Fix with AI dialog). A `--model haiku` kept
 * in the Arguments box would otherwise win, and the CLI would start on it instead of the pick. Everything else in the
 * configured string is left exactly as the user wrote it.
 */
export function configuredArgsWithout(configuredArgs: string, runArgs: string[]): string {
  const flags = new Set<string>();
  const configKeys = new Set<string>();
  for (let i = 0; i + 1 < runArgs.length; i += 2) {
    const flag = runArgs[i]!;
    if (flag === '-c') configKeys.add(runArgs[i + 1]!.split('=')[0]!);
    else for (const name of [flag, ...(RUN_FLAG_ALIASES[flag] ?? [])]) flags.add(name);
  }
  if (flags.size === 0 && configKeys.size === 0) return configuredArgs;

  const tokens = [...configuredArgs.matchAll(/\S+/g)].map((m) => ({
    text: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
  const cut: { start: number; end: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    const [name, inlineValue] = token.text.split(/=(.*)/s);
    if (flags.has(name!)) {
      // `--model=opus` is one token; `--model opus` takes the value with it.
      const takesNext = inlineValue === undefined && next && !next.text.startsWith('-');
      cut.push({ start: token.start, end: takesNext ? next.end : token.end });
      if (takesNext) i++;
    } else if (token.text === '-c' && next && configKeys.has(next.text.split('=')[0]!)) {
      cut.push({ start: token.start, end: next.end });
      i++;
    }
  }
  if (cut.length === 0) return configuredArgs;

  const kept: string[] = [];
  let from = 0;
  for (const range of cut) {
    kept.push(configuredArgs.slice(from, range.start));
    from = range.end;
  }
  kept.push(configuredArgs.slice(from));
  // Only the edges of each kept piece are trimmed, so spacing inside a quoted value survives.
  return kept
    .map((piece) => piece.trim())
    .filter(Boolean)
    .join(' ');
}

export type CostLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Where a choice sits on this CLI's own cost range, 1 being its cheapest run and 5 its
 * priciest. It's relative on purpose: token counts depend on the repo and the agent's
 * path through it, so a dollar figure per task would be a guess dressed up as a number.
 */
export function relativeCostLevel(profile: TargetRunProfile, choice: RunChoice): CostLevel {
  const value = (m: RunModelOption, e: EffortLevel | undefined) =>
    m.costWeight * (e ? EFFORT_COST_FACTOR[e] : 1);
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const m of profile.models) {
    const levels = m.efforts?.length ? m.efforts : [undefined];
    for (const e of levels) {
      const v = value(m, e);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  const current = value(choice.model, choice.effort);
  if (max <= min) return 3;
  const t = Math.log(current / min) / Math.log(max / min);
  return clamp(Math.round(1 + t * 4), 1, 5) as CostLevel;
}
