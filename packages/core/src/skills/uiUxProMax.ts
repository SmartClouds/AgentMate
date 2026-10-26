/**
 * UI UX Pro Max (https://github.com/nextlevelbuilder/ui-ux-pro-max-skill), a featured skill that
 * Runova installs through the project's own `uipro` CLI instead of through a skill repository.
 * The repo generates every platform's files from templates at install time, so copying files out
 * of it would not produce a working install; the CLI is the supported path. Everything below
 * mirrors the project's README (v2.x).
 */

export const UI_UX_PRO_MAX_REPO = 'nextlevelbuilder/ui-ux-pro-max-skill';
export const UI_UX_PRO_MAX_SKILL_NAME = 'ui-ux-pro-max';
/** `owner/repo/skillName`, matching how skills.sh entries are keyed in installed-skills.json. */
export const UI_UX_PRO_MAX_SKILL_ID = `${UI_UX_PRO_MAX_REPO}/${UI_UX_PRO_MAX_SKILL_NAME}`;
export const UI_UX_PRO_MAX_GITHUB_URL = `https://github.com/${UI_UX_PRO_MAX_REPO}`;
export const UI_UX_PRO_MAX_HOMEPAGE = 'https://uupm.cc';
export const UI_UX_PRO_MAX_NPM_PACKAGE = 'ui-ux-pro-max-cli';
export const UI_UX_PRO_MAX_PYTHON_URL = 'https://www.python.org/downloads/';

/**
 * `repositoryId` stamped on InstalledSkillRecord entries for this skill, so removal knows to run
 * `uipro uninstall` rather than deleting a folder Runova itself wrote. Same idea as
 * SKILLS_SH_PSEUDO_REPOSITORY_ID: there is no matching entry in the SkillRepository store.
 */
export const UI_UX_PRO_MAX_PSEUDO_REPOSITORY_ID = 'ui-ux-pro-max-cli';

/** How the skill is triggered once installed, which differs per assistant. */
export type UiProActivationMode = 'skill' | 'workflow' | 'both';

/** How the `uipro` CLI itself is obtained. */
export type UiProInstallMethod = 'npm-global' | 'npx' | 'claude-plugin';

export interface UiProAiTarget {
  /** Value passed to `uipro init --ai <value>`. */
  value: string;
  label: string;
  mode: UiProActivationMode;
  /** Project-relative folder the skill lands in, where the README documents it. */
  skillDir?: string;
  /** Anything the README calls out for this assistant specifically. */
  note?: string;
}

/**
 * The `--ai` values the CLI accepts, in the README's own order. `all` is not listed here: it is a
 * separate toggle in the wizard, since it means "every assistant" rather than one more target.
 */
export const UI_UX_PRO_MAX_AI_TARGETS: UiProAiTarget[] = [
  { value: 'claude', label: 'Claude Code', mode: 'skill', skillDir: '.claude/skills' },
  { value: 'cursor', label: 'Cursor', mode: 'skill', skillDir: '.cursor/skills' },
  { value: 'windsurf', label: 'Windsurf', mode: 'skill', skillDir: '.windsurf/skills' },
  { value: 'antigravity', label: 'Antigravity', mode: 'skill', skillDir: '.agents/skills' },
  { value: 'copilot', label: 'GitHub Copilot', mode: 'workflow' },
  { value: 'kiro', label: 'Kiro', mode: 'workflow' },
  { value: 'codex', label: 'Codex CLI', mode: 'skill', skillDir: '.agents/skills' },
  { value: 'qoder', label: 'Qoder', mode: 'skill' },
  { value: 'roocode', label: 'Roo Code', mode: 'workflow' },
  { value: 'gemini', label: 'Gemini CLI', mode: 'skill' },
  {
    value: 'trae',
    label: 'Trae',
    mode: 'skill',
    note: 'Switch Trae to SOLO mode first, then the skill activates on UI/UX requests.',
  },
  { value: 'opencode', label: 'OpenCode', mode: 'skill' },
  { value: 'continue', label: 'Continue', mode: 'skill', skillDir: '.continue/skills' },
  { value: 'codebuddy', label: 'CodeBuddy', mode: 'skill' },
  { value: 'droid', label: 'Droid (Factory)', mode: 'skill', skillDir: '.factory/skills' },
  { value: 'kilocode', label: 'KiloCode', mode: 'both' },
  { value: 'warp', label: 'Warp', mode: 'skill' },
  { value: 'augment', label: 'Augment', mode: 'skill' },
  { value: 'codewhale', label: 'CodeWhale', mode: 'skill' },
  {
    value: 'universal',
    label: 'Universal (Agent Standard)',
    mode: 'skill',
    skillDir: '.agents/skills',
    note: 'Writes to the shared .agents/skills folder that agent-standard tools read.',
  },
];

/** Selecting every assistant collapses to this single `--ai` value. */
export const UI_UX_PRO_MAX_ALL_AGENTS = 'all';

const KNOWN_AI_VALUES = new Set([
  ...UI_UX_PRO_MAX_AI_TARGETS.map((t) => t.value),
  UI_UX_PRO_MAX_ALL_AGENTS,
]);

/** Guards every value that reaches a shell command or a stored record. */
export function isUiProAiTarget(value: string): boolean {
  return KNOWN_AI_VALUES.has(value);
}

/** The two commands typed inside Claude Code itself to install via the plugin marketplace. */
export const UI_UX_PRO_MAX_PLUGIN_COMMANDS: string[] = [
  `/plugin marketplace add ${UI_UX_PRO_MAX_REPO}`,
  `/plugin install ${UI_UX_PRO_MAX_SKILL_NAME}@ui-ux-pro-max-skill`,
];

export interface UiProCommandOptions {
  method: UiProInstallMethod;
  /** `--ai` values, or `['all']`. */
  agents: string[];
  /** Adds `--global`, which installs to ~/.claude/skills (and the equivalent per assistant). */
  global: boolean;
}

export interface UiProCommandPlan {
  /** Run once before the per-assistant commands. Empty for npx, which needs no install step. */
  setup: string[];
  /** One command per selected assistant. */
  install: string[];
}

function commandPrefix(method: UiProInstallMethod): string {
  return method === 'npx' ? `npx ${UI_UX_PRO_MAX_NPM_PACKAGE}` : 'uipro';
}

function withGlobal(command: string, global: boolean): string {
  return global ? `${command} --global` : command;
}

/**
 * Builds the shell commands for an install. `claude-plugin` has no shell commands of its own
 * (see UI_UX_PRO_MAX_PLUGIN_COMMANDS), so it returns an empty plan.
 */
export function buildUiProCommandPlan(options: UiProCommandOptions): UiProCommandPlan {
  if (options.method === 'claude-plugin') return { setup: [], install: [] };

  const agents = options.agents.filter(isUiProAiTarget);
  const prefix = commandPrefix(options.method);
  return {
    setup: options.method === 'npm-global' ? [`npm install -g ${UI_UX_PRO_MAX_NPM_PACKAGE}`] : [],
    install: agents.map((agent) => withGlobal(`${prefix} init --ai ${agent}`, options.global)),
  };
}

/** `uipro uninstall` per assistant. Removing a global install needs the `--global` flag too. */
export function buildUiProUninstallCommands(options: UiProCommandOptions): string[] {
  const prefix = commandPrefix(options.method === 'npx' ? 'npx' : 'npm-global');
  const agents = options.agents.filter(isUiProAiTarget);
  if (agents.length === 0) return [withGlobal(`${prefix} uninstall`, options.global)];
  return agents.map((agent) => withGlobal(`${prefix} uninstall --ai ${agent}`, options.global));
}

/** `uipro update` refreshes the installed skill files from the CLI package. */
export function buildUiProUpdateCommand(method: UiProInstallMethod, global: boolean): string {
  return withGlobal(`${commandPrefix(method === 'npx' ? 'npx' : 'npm-global')} update`, global);
}

/**
 * Updating means two things: pulling the newest CLI from npm, then re-running `uipro update` so
 * the installed skill files are regenerated from it. Like the install plan, `claude-plugin` has no
 * shell commands (the plugin is updated from inside Claude Code).
 */
export function buildUiProUpdatePlan(options: {
  method: UiProInstallMethod;
  global: boolean;
}): UiProCommandPlan {
  if (options.method === 'claude-plugin') return { setup: [], install: [] };
  return {
    setup:
      options.method === 'npm-global' ? [`npm install -g ${UI_UX_PRO_MAX_NPM_PACKAGE}@latest`] : [],
    install: [buildUiProUpdateCommand(options.method, options.global)],
  };
}

/**
 * The design-system generator, invoked directly. The script path depends on which assistant the
 * skill was installed for, hence the folder argument.
 */
export function buildUiProDesignSystemCommand(
  skillDir: string,
  query: string,
  projectName?: string,
): string {
  const script = `${skillDir}/${UI_UX_PRO_MAX_SKILL_NAME}/scripts/search.py`;
  const project = projectName ? ` -p "${projectName}"` : '';
  return `python3 ${script} "${query}" --design-system${project}`;
}

export interface UiProHighlight {
  count: string;
  label: string;
  detail: string;
}

/** The headline numbers from the README, used on the skill card. */
export const UI_UX_PRO_MAX_HIGHLIGHTS: UiProHighlight[] = [
  {
    count: '84',
    label: 'UI styles',
    detail: 'Glassmorphism, Claymorphism, Brutalism, Bento Grid, AI-Native UI, and more',
  },
  {
    count: '192',
    label: 'Color palettes',
    detail: 'Industry-specific palettes aligned 1:1 with the 192 product types',
  },
  {
    count: '74',
    label: 'Font pairings',
    detail: 'Curated typography combinations with Google Fonts imports',
  },
  {
    count: '161',
    label: 'Reasoning rules',
    detail: 'Industry-specific design system generation',
  },
  { count: '22', label: 'Tech stacks', detail: 'React, Next.js, Vue, SwiftUI, Flutter, Laravel…' },
  { count: '98', label: 'UX guidelines', detail: 'Best practices, anti-patterns, accessibility' },
];

/** The reasoning-rule categories table from the README. */
export const UI_UX_PRO_MAX_RULE_CATEGORIES: { category: string; examples: string }[] = [
  {
    category: 'Tech & SaaS',
    examples: 'SaaS, Micro SaaS, Developer Tool, AI/Chatbot, Cybersecurity',
  },
  { category: 'Finance', examples: 'Fintech/Crypto, Banking, Insurance, Invoice & Billing' },
  { category: 'Healthcare', examples: 'Clinic, Pharmacy, Dental, Veterinary, Mental Health' },
  {
    category: 'E-commerce',
    examples: 'General, Luxury, Marketplace, Subscription Box, Food Delivery',
  },
  { category: 'Services', examples: 'Beauty/Spa, Restaurant, Hotel, Legal, Home Services' },
  { category: 'Creative', examples: 'Portfolio, Agency, Photography, Gaming, Music Streaming' },
  { category: 'Lifestyle', examples: 'Habit Tracker, Recipe, Meditation, Weather, Mood Tracker' },
  { category: 'Emerging Tech', examples: 'Web3/NFT, Spatial Computing, Quantum, Drone Fleet' },
];

/** The supported-stacks table from the README. */
export const UI_UX_PRO_MAX_STACK_GROUPS: { group: string; stacks: string }[] = [
  { group: 'Web (HTML)', stacks: 'HTML + Tailwind (default)' },
  { group: 'React', stacks: 'React, Next.js, shadcn/ui' },
  { group: 'Vue', stacks: 'Vue, Nuxt.js, Nuxt UI' },
  { group: 'Other web', stacks: 'Angular, Svelte, Astro, Three.js, Laravel' },
  { group: 'Desktop', stacks: 'JavaFX, WPF, WinUI 3, Avalonia, Uno Platform, UWP' },
  { group: 'Mobile', stacks: 'SwiftUI, Jetpack Compose, React Native, Flutter' },
];

/** Prompts the README gives as examples of what activates the skill. */
export const UI_UX_PRO_MAX_EXAMPLE_PROMPTS: string[] = [
  'Build a landing page for my SaaS product',
  'Create a dashboard for healthcare analytics',
  'Design a portfolio website with dark mode',
  'Make a mobile app UI for e-commerce',
  'Build a fintech banking app with dark theme',
];
