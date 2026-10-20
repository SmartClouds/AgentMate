import { CURSOR_MODELS, GROK_MODELS } from '../models/catalog.js';
import {
  type CostLevel,
  defaultEffortFor,
  EFFORT_LABELS,
  type EffortLevel,
  relativeCostLevel,
  runProfileForTargetAI,
} from '../promptBuilder/runRecommendation.js';
import { getCliDefinition } from './registry.js';

/**
 * What a CLI starts on when AgentMate opens it in a terminal: a model, a reasoning effort, and a
 * permission mode. Every field is optional on purpose. A field the user left unset adds no flag
 * at all, so the CLI falls back to its own config exactly as if it had been started by hand.
 */
export interface CliLaunchDefault {
  /** Value for the CLI's model flag, e.g. "opus" or "gpt-6-sol". */
  model?: string;
  effort?: EffortLevel;
  /** Id of one of the CLI's launch modes (see CliLaunchOptions.modes). */
  mode?: string;
}

/** Launch defaults keyed by CLI id. CLIs with nothing set have no key. */
export type CliLaunchDefaultsMap = Record<string, CliLaunchDefault>;

export interface CliLaunchModelOption {
  value: string;
  label: string;
  /** Effort levels this model accepts. Absent when the model has no effort setting. */
  efforts?: readonly EffortLevel[];
}

export interface CliLaunchMode {
  id: string;
  label: string;
  description: string;
  args: readonly string[];
  /** Lets the agent act without asking. Shown with a warning. */
  risky?: boolean;
}

export interface CliLaunchOptions {
  cliId: string;
  modelFlag?: string;
  /** Known models to pick from. A CLI without a list takes a model name typed by hand. */
  models: readonly CliLaunchModelOption[];
  /** Placeholder for a hand-typed model name. */
  modelPlaceholder?: string;
  efforts: readonly EffortLevel[];
  effortArgs?: (level: EffortLevel) => string[];
  modes: readonly CliLaunchMode[];
  /**
   * Flags that already set a mode when a launch carries them, so the saved mode is not added on
   * top of them.
   */
  modeFlags: readonly string[];
}

interface ModeSpec {
  modes: readonly CliLaunchMode[];
  flags: readonly string[];
}

const CLAUDE_MODES: ModeSpec = {
  flags: ['--permission-mode', '--dangerously-skip-permissions'],
  modes: [
    {
      id: 'manual',
      label: 'Ask first',
      description: 'Asks before edits and commands.',
      args: ['--permission-mode', 'manual'],
    },
    {
      id: 'acceptEdits',
      label: 'Accept edits',
      description: 'Edits files without asking, still asks before commands.',
      args: ['--permission-mode', 'acceptEdits'],
    },
    {
      id: 'plan',
      label: 'Plan',
      description: 'Reads and plans, makes no changes.',
      args: ['--permission-mode', 'plan'],
    },
    {
      id: 'auto',
      label: 'Auto',
      description: 'Decides on its own which actions are safe to run.',
      args: ['--permission-mode', 'auto'],
    },
    {
      id: 'bypassPermissions',
      label: 'Bypass permissions',
      description: 'Runs everything without asking.',
      args: ['--permission-mode', 'bypassPermissions'],
      risky: true,
    },
  ],
};

/** CLIs that only document how to start a session in a particular mode get an entry here. */
const MODE_SPECS: Record<string, ModeSpec> = {
  'claude-code': CLAUDE_MODES,
  openclaude: {
    flags: CLAUDE_MODES.flags,
    modes: [
      {
        id: 'default',
        label: 'Ask first',
        description: 'Asks before edits and commands.',
        args: ['--permission-mode', 'default'],
      },
      ...CLAUDE_MODES.modes.filter((mode) => mode.id !== 'manual' && mode.id !== 'auto'),
    ],
  },
  'grok-cli': {
    flags: ['--permission-mode'],
    modes: [
      {
        id: 'default',
        label: 'Ask first',
        description: 'Asks before edits and commands.',
        args: ['--permission-mode', 'default'],
      },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        description: 'Edits files without asking, still asks before commands.',
        args: ['--permission-mode', 'acceptEdits'],
      },
      {
        id: 'plan',
        label: 'Plan',
        description: 'Reads and plans, makes no changes.',
        args: ['--permission-mode', 'plan'],
      },
      {
        id: 'auto',
        label: 'Auto',
        description: 'Decides on its own which actions are safe to run.',
        args: ['--permission-mode', 'auto'],
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        description: 'Runs everything without asking.',
        args: ['--permission-mode', 'bypassPermissions'],
        risky: true,
      },
    ],
  },
  'codex-cli': {
    flags: [
      '--sandbox',
      '-s',
      '--ask-for-approval',
      '-a',
      '--approve-for-me',
      '--full-auto',
      '--dangerously-bypass-approvals-and-sandbox',
      '--yolo',
    ],
    modes: [
      {
        id: 'read-only',
        label: 'Read only',
        description: 'Can read the project but not change it.',
        args: ['--sandbox', 'read-only'],
      },
      {
        id: 'ask',
        label: 'Ask first',
        description: 'Works in the project folder and asks when it needs more.',
        args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
      },
      {
        id: 'auto',
        label: 'Auto',
        description: 'Approval requests are reviewed automatically, inside the sandbox.',
        args: ['--approve-for-me'],
      },
      {
        id: 'full-access',
        label: 'Full access',
        description: 'No sandbox and no approvals.',
        args: ['--dangerously-bypass-approvals-and-sandbox'],
        risky: true,
      },
    ],
  },
  'gemini-cli': {
    flags: ['--approval-mode', '--yolo', '-y'],
    modes: [
      {
        id: 'default',
        label: 'Ask first',
        description: 'Asks before running tools.',
        args: ['--approval-mode', 'default'],
      },
      {
        id: 'auto_edit',
        label: 'Accept edits',
        description: 'Edits files without asking.',
        args: ['--approval-mode', 'auto_edit'],
      },
      {
        id: 'plan',
        label: 'Plan',
        description: 'Read only, makes no changes.',
        args: ['--approval-mode', 'plan'],
      },
      {
        id: 'yolo',
        label: 'YOLO',
        description: 'Runs every tool without asking.',
        args: ['--approval-mode', 'yolo'],
        risky: true,
      },
    ],
  },
  'qwen-cli': {
    flags: ['--approval-mode', '--yolo', '-y'],
    modes: [
      {
        id: 'yolo',
        label: 'YOLO',
        description: 'Runs every tool without asking.',
        args: ['--yolo'],
        risky: true,
      },
    ],
  },
  'cursor-cli': {
    flags: ['--mode', '--plan', '--force', '-f', '--yolo'],
    modes: [
      {
        id: 'plan',
        label: 'Plan',
        description: 'Analyzes and proposes plans, makes no edits.',
        args: ['--mode', 'plan'],
      },
      {
        id: 'ask',
        label: 'Ask',
        description: 'Questions and explanations only, read only.',
        args: ['--mode', 'ask'],
      },
      {
        id: 'force',
        label: 'Run everything',
        description: 'Allows commands unless they are explicitly denied.',
        args: ['--force'],
        risky: true,
      },
    ],
  },
  'copilot-cli': {
    flags: ['--mode', '--plan', '--autopilot', '--allow-all', '--allow-all-tools', '--yolo'],
    modes: [
      {
        id: 'plan',
        label: 'Plan',
        description: 'Starts by planning before it changes anything.',
        args: ['--mode', 'plan'],
      },
      {
        id: 'autopilot',
        label: 'Autopilot',
        description: 'Keeps working on its own until the task is done.',
        args: ['--mode', 'autopilot'],
      },
      {
        id: 'allow-all',
        label: 'Allow all',
        description: 'Every tool, path, and URL without asking.',
        args: ['--allow-all'],
        risky: true,
      },
    ],
  },
};

const ALL_EFFORTS = Object.keys(EFFORT_LABELS) as EffortLevel[];

const GROK_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high'];

/** Effort flags for CLIs that have one but no model profile to take it from. */
const EFFORT_SPECS: Record<string, Pick<CliLaunchOptions, 'efforts' | 'effortArgs'>> = {
  'copilot-cli': {
    efforts: ALL_EFFORTS,
    effortArgs: (level) => ['--reasoning-effort', level],
  },
  'grok-cli': {
    efforts: GROK_EFFORTS,
    effortArgs: (level) => ['--reasoning-effort', level],
  },
};

/**
 * Known models for CLIs that have no run profile. Without an entry here such a CLI only takes a
 * model name typed by hand.
 */
const MODEL_SPECS: Record<string, readonly CliLaunchModelOption[]> = {
  'grok-cli': Object.values(GROK_MODELS).map((model) => ({
    value: model.cliArg,
    label: model.label,
    efforts: GROK_EFFORTS,
  })),
  'cursor-cli': Object.values(CURSOR_MODELS).map((model) => ({
    value: model.cliArg,
    label: model.label,
  })),
};

/** What can be preset for a CLI's launch. Null when AgentMate knows no launch flags for it. */
export function cliLaunchOptions(cliId: string): CliLaunchOptions | null {
  const cli = getCliDefinition(cliId);
  if (!cli) return null;
  const profile = runProfileForTargetAI(cliId);
  const models: readonly CliLaunchModelOption[] = profile.generic
    ? (MODEL_SPECS[cliId] ?? [])
    : profile.models
        .filter((model) => model.modelArg)
        .map((model) => ({ value: model.modelArg!, label: model.label, efforts: model.efforts }));
  const profileEfforts = profile.effortArgs
    ? ALL_EFFORTS.filter((level) => profile.models.some((m) => m.efforts?.includes(level)))
    : [];
  const effortSpec = EFFORT_SPECS[cliId];
  const modeSpec = MODE_SPECS[cliId];
  const options: CliLaunchOptions = {
    cliId,
    modelFlag: profile.modelFlag,
    models,
    modelPlaceholder: profile.modelFlag
      ? cli.argsExample?.split(/\s+/).slice(1).join(' ') || undefined
      : undefined,
    efforts: profileEfforts.length ? profileEfforts : (effortSpec?.efforts ?? []),
    effortArgs: profileEfforts.length ? profile.effortArgs : effortSpec?.effortArgs,
    modes: modeSpec?.modes ?? [],
    modeFlags: modeSpec?.flags ?? [],
  };
  const hasAnything = options.modelFlag || options.efforts.length || options.modes.length;
  return hasAnything ? options : null;
}

/** The flag names an argument group sets, for spotting it among the user's own arguments. */
function flagKeys(args: readonly string[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-c' && args[i + 1]) {
      keys.push(`${args[i + 1]!.split('=')[0]}=`);
      i++;
    } else if (arg.startsWith('-')) keys.push(arg);
  }
  return keys;
}

function setsAny(taken: readonly string[], keys: readonly string[]): boolean {
  return keys.some((key) =>
    key.endsWith('=')
      ? taken.some((arg) => arg.startsWith(key))
      : taken.some((arg) => arg === key || arg.startsWith(`${key}=`)),
  );
}

function modelFlagKeys(modelFlag: string): string[] {
  return modelFlag === '--model' ? ['--model', '-m'] : [modelFlag];
}

function effortFlagKeys(effortArgs: readonly string[]): string[] {
  return [...flagKeys(effortArgs), ...(effortArgs[0] === '--reasoning-effort' ? ['--effort'] : [])];
}

/**
 * Whether a CLI takes this effort with this model. A model the CLI's list doesn't know (typed by
 * hand) is given the benefit of the doubt.
 */
function effortFitsModel(
  options: CliLaunchOptions,
  model: string | undefined,
  effort: EffortLevel,
): boolean {
  const known = options.models.find((m) => m.value === model);
  return options.efforts.includes(effort) && (!known || !!known.efforts?.includes(effort));
}

export interface LaunchDefaultPart {
  kind: 'model' | 'effort' | 'mode';
  args: string[];
  /** False when this launch's own picks already set the same thing. */
  applied: boolean;
}

/**
 * Turns a CLI's launch defaults into flags, one group per field that is set. `takenArgs` are
 * the arguments the launch already carries (a model and effort picked for this one run). A
 * default never fights them: a group whose flag is already there is marked not applied.
 */
export function launchDefaultParts(
  cliId: string,
  defaults: CliLaunchDefault | undefined,
  takenArgs: readonly string[] = [],
): LaunchDefaultPart[] {
  const options = cliLaunchOptions(cliId);
  if (!options || !defaults) return [];
  const parts: LaunchDefaultPart[] = [];

  const model = defaults.model?.trim();
  if (model && options.modelFlag) {
    parts.push({
      kind: 'model',
      args: [options.modelFlag, model],
      applied: !setsAny(takenArgs, modelFlagKeys(options.modelFlag)),
    });
  }

  // An effort the chosen model can't take is left off rather than sent to fail.
  // The model that really runs is the one already in the launch's arguments, when they set one.
  const takenModel = options.modelFlag
    ? findTakenFlag(takenArgs, modelFlagKeys(options.modelFlag))?.value
    : undefined;
  const effortFits =
    defaults.effort && effortFitsModel(options, takenModel ?? model, defaults.effort);
  if (effortFits && options.effortArgs && defaults.effort) {
    const args = options.effortArgs(defaults.effort);
    parts.push({ kind: 'effort', args, applied: !setsAny(takenArgs, effortFlagKeys(args)) });
  }

  const mode = options.modes.find((m) => m.id === defaults.mode);
  if (mode) {
    parts.push({
      kind: 'mode',
      args: [...mode.args],
      applied: !setsAny(takenArgs, options.modeFlags),
    });
  }
  return parts;
}

/** The launch-default flags to add to a launch, leaving out whatever it already sets. */
export function launchDefaultArgs(
  cliId: string,
  defaults: CliLaunchDefault | undefined,
  takenArgs: readonly string[] = [],
): string[] {
  return launchDefaultParts(cliId, defaults, takenArgs)
    .filter((part) => part.applied)
    .flatMap((part) => part.args);
}

/** A model, and an effort for it, chosen for one launch from the "+" menu. */
export interface LaunchPick {
  model?: string;
  effort?: EffortLevel;
}

/** The CLIs whose "+" menu row opens a model and effort picker. */
export const LAUNCH_PICK_CLI_IDS: readonly string[] = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'grok-cli',
  'cursor-cli',
];

export interface LaunchPickModel extends CliLaunchModelOption {
  /** Short tier name from the run profile, e.g. "Fast". Absent for a CLI without a profile. */
  tier?: string;
  /** Where the model sits on its CLI's cost range at its default effort. */
  costLevel?: CostLevel;
  /** The same cost level for each effort the model accepts. */
  effortCost?: Partial<Record<EffortLevel, CostLevel>>;
}

export interface LaunchPickOptions {
  cliId: string;
  models: readonly LaunchPickModel[];
}

/**
 * What the "+" menu offers when launching a CLI with a model and effort picked for that one run.
 * Null for a CLI that has no picker, or no model list to pick from.
 */
export function launchPickOptions(cliId: string): LaunchPickOptions | null {
  if (!LAUNCH_PICK_CLI_IDS.includes(cliId)) return null;
  const options = cliLaunchOptions(cliId);
  if (!options?.modelFlag || options.models.length === 0) return null;
  const profile = runProfileForTargetAI(cliId);
  const models = options.models.map((model): LaunchPickModel => {
    const run = profile.generic
      ? undefined
      : profile.models.find((m) => m.modelArg === model.value);
    if (!run) return model;
    const effortCost: Partial<Record<EffortLevel, CostLevel>> = {};
    for (const effort of run.efforts ?? []) {
      effortCost[effort] = relativeCostLevel(profile, { model: run, effort });
    }
    return {
      ...model,
      tier: run.tier,
      costLevel: relativeCostLevel(profile, { model: run, effort: defaultEffortFor(run) }),
      ...(run.efforts?.length ? { effortCost } : {}),
    };
  });
  return { cliId, models };
}

/**
 * The flags for one launch's pick: the model flag and model, then the effort when this model
 * takes it. A pick without a model adds nothing, so the CLI starts on its own defaults.
 */
export function launchPickArgs(cliId: string, pick: LaunchPick): string[] {
  const options = cliLaunchOptions(cliId);
  const model = pick.model?.trim();
  if (!options?.modelFlag || !model) return [];
  const args = [options.modelFlag, model];
  if (pick.effort && options.effortArgs && effortFitsModel(options, model, pick.effort)) {
    args.push(...options.effortArgs(pick.effort));
  }
  return args;
}

/**
 * A pick in words, like "Opus 5.5 · High", for a tab or a menu row. An effort the model can't
 * take is left out, as it is from the flags. With no model, a bare effort reads "High effort".
 */
export function launchPickLabel(cliId: string, pick: LaunchPick): string | undefined {
  const options = cliLaunchOptions(cliId);
  if (!options) return undefined;
  const model = pick.model?.trim();
  const effort = pick.effort;
  if (!model) {
    return effort && options.efforts.includes(effort)
      ? `${EFFORT_LABELS[effort]} effort`
      : undefined;
  }
  const label = options.models.find((m) => m.value === model)?.label ?? model;
  return effort && effortFitsModel(options, model, effort)
    ? `${label} · ${EFFORT_LABELS[effort]}`
    : label;
}

/** A flag found in a launch's arguments, with the value right after it when it takes one. */
interface TakenFlag {
  flag: string;
  value?: string;
}

function findTakenFlag(
  takenArgs: readonly string[],
  keys: readonly string[],
): TakenFlag | undefined {
  for (let i = 0; i < takenArgs.length; i++) {
    const arg = takenArgs[i]!;
    const next = takenArgs[i + 1];
    for (const key of keys) {
      if (key.endsWith('=')) {
        if (arg === '-c' && next?.startsWith(key)) return { flag: '-c', value: next };
      } else if (arg === key) {
        return next !== undefined && !next.startsWith('-')
          ? { flag: key, value: next }
          : { flag: key };
      } else if (arg.startsWith(`${key}=`)) {
        return { flag: key, value: arg.slice(key.length + 1) };
      }
    }
  }
  return undefined;
}

/**
 * Keeps a hand-edited or older settings file from putting junk into a launch. Unknown modes,
 * efforts, and empty entries are dropped, so an unset field really adds nothing.
 */
export function normalizeCliLaunchDefaults(value: unknown): CliLaunchDefaultsMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: CliLaunchDefaultsMap = {};
  for (const [cliId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const next: CliLaunchDefault = {};
    if (typeof entry.model === 'string' && entry.model.trim()) next.model = entry.model.trim();
    if (typeof entry.effort === 'string' && entry.effort in EFFORT_LABELS) {
      next.effort = entry.effort as EffortLevel;
    }
    if (typeof entry.mode === 'string' && entry.mode) next.mode = entry.mode;
    if (next.model || next.effort || next.mode) result[cliId] = next;
  }
  return result;
}
