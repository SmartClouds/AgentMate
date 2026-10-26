import { AGENT_TYPE_LABELS } from '../cli/agentTypes.js';
import { CODEX_CONFIG_EXAMPLE_MODEL } from '../models/catalog.js';
import type { AgentType } from '../types/index.js';

export interface BootstrapFile {
  relativePath: string;
  content: string;
}

export interface ProjectMeta {
  name: string;
  description: string;
  agentType: AgentType;
}

export interface BootstrapPlan {
  /** Human label for the agent, e.g. "Claude Code". */
  agentLabel: string;
  /** The agent's project config directory, e.g. ".claude". Empty when the agent has none. */
  agentDir: string;
  /** Official docs describing this layout. */
  docsUrl: string;
  /** Directories to create (POSIX-separated, relative to the project root). */
  folders: string[];
  /** Files to create (skipped when they already exist). */
  files: BootstrapFile[];
}

/** Runova's own project folder, created for every agent type. */
export const RUNOVA_DIR = '.runova';

const AGENT_LABELS: Record<AgentType, string> = {
  ...AGENT_TYPE_LABELS,
  generic: 'a generic AI coding agent',
};

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

function overview(meta: ProjectMeta): string {
  return meta.description || '_(describe what this project does)_';
}

/**
 * Body shared by every agent instruction file (CLAUDE.md / GEMINI.md / AGENTS.md).
 * Kept short on purpose: these files are loaded into context on every session.
 */
function instructionsBody(meta: ProjectMeta): string {
  return `## Overview

${overview(meta)}

## Commands

- Install: \`(fill in)\`
- Build: \`(fill in)\`
- Test: \`(fill in)\`
- Lint: \`(fill in)\`

## Architecture

- (describe the main modules and how they fit together)

## Conventions

- Match the style of surrounding code; don't reformat unrelated lines.
- Prefer small, reviewable changes.
- Add or update tests alongside behavior changes.

## Gotchas

- (record anything that surprised you here, so it isn't rediscovered)
`;
}

function runovaDocs(meta: ProjectMeta): BootstrapFile[] {
  return [
    {
      relativePath: `${RUNOVA_DIR}/PROJECT_CONTEXT.md`,
      content: `# ${meta.name}: Project Context

Background an agent can't infer from the code. Managed in Runova.

## Overview

${overview(meta)}

## Goals

- (what success looks like)

## Constraints

- (deadlines, platforms, compliance, performance budgets)

## Stakeholders

- (who to ask about what)

## External systems

- (APIs, services, credentials required to run this locally)
`,
    },
    {
      relativePath: `${RUNOVA_DIR}/ROADMAP.md`,
      content: `# Roadmap

## Now

-

## Next

-

## Later

-
`,
    },
    {
      relativePath: `${RUNOVA_DIR}/TASKS.md`,
      content: `# Tasks

- [ ] (add tasks here)
`,
    },
  ];
}

/**
 * The `AGENTS.md` open standard, used by Codex, opencode, Cursor and others.
 * `layout` documents where that agent looks for its own config.
 */
function agentsMd(meta: ProjectMeta, agentLabel: string, layout: string): BootstrapFile {
  return {
    relativePath: 'AGENTS.md',
    content: `# ${meta.name}

Instructions for AI coding agents working in this repository.
Primary agent: **${agentLabel}**. Scaffolded by Runova.

${instructionsBody(meta)}
${layout}`,
  };
}

const REVIEW_DIFF_PROMPT = `Review the uncommitted changes in this repository.

1. Run \`git diff\` (and \`git diff --staged\`) to see what changed.
2. Flag correctness bugs, missing error handling, and untested behavior.
3. Point out anything that contradicts the project conventions.

Report findings most-severe first. Don't fix anything unless asked.`;

function gitkeep(dir: string): BootstrapFile {
  return {
    relativePath: `${dir}/.gitkeep`,
    content: '',
  };
}

// ---------------------------------------------------------------------------
// Per-agent layouts
// ---------------------------------------------------------------------------

/**
 * Claude Code: https://code.claude.com/docs/en/memory
 * Project instructions live at `./CLAUDE.md` or `./.claude/CLAUDE.md`; settings,
 * rules, subagents, skills and slash commands all live under `.claude/`.
 */
function claudeCodePlan(meta: ProjectMeta): BootstrapPlan {
  return {
    agentLabel: AGENT_LABELS['claude-code'],
    agentDir: '.claude',
    docsUrl: 'https://code.claude.com/docs/en/memory',
    folders: [
      '.claude',
      '.claude/rules',
      '.claude/agents',
      '.claude/skills',
      '.claude/commands',
      RUNOVA_DIR,
    ],
    files: [
      {
        relativePath: '.claude/CLAUDE.md',
        content: `# ${meta.name}

Project instructions for Claude Code. Loaded at the start of every session,
so keep this under ~200 lines.

${instructionsBody(meta)}
## Layout of this folder

- \`.claude/rules/\`: topic files loaded every session; add \`paths:\` frontmatter to scope a rule to matching files.
- \`.claude/agents/\`: subagent definitions (\`<name>.md\` with \`name\`/\`description\` frontmatter).
- \`.claude/skills/\`: skills (\`<name>/SKILL.md\`), loaded on demand.
- \`.claude/commands/\`: slash commands (\`<name>.md\` → \`/<name>\`).
- \`.claude/settings.json\`: shared permissions and hooks; \`settings.local.json\` for personal overrides.

Docs: https://code.claude.com/docs/en/memory
`,
      },
      {
        relativePath: '.claude/settings.json',
        content: `${JSON.stringify(
          {
            $schema: 'https://json.schemastore.org/claude-code-settings.json',
            permissions: {
              allow: [],
              deny: ['Read(./.env)', 'Read(./.env.*)', 'Read(./secrets/**)'],
            },
          },
          null,
          2,
        )}\n`,
      },
      {
        relativePath: '.claude/rules/project-conventions.md',
        content: `# Project Conventions

Rules without \`paths:\` frontmatter load in every session. To scope a rule to
certain files, add frontmatter like:

\`\`\`yaml
---
paths:
  - "src/**/*.{ts,tsx}"
---
\`\`\`

- (add a convention here)
`,
      },
      {
        relativePath: '.claude/commands/review-diff.md',
        content: `---
description: Review the uncommitted changes in this repository
---

${REVIEW_DIFF_PROMPT}
`,
      },
      gitkeep('.claude/agents'),
      gitkeep('.claude/skills'),
      ...runovaDocs(meta),
    ],
  };
}

/**
 * Gemini CLI: https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html
 * Context lives in `GEMINI.md` at the root; settings and TOML commands under `.gemini/`.
 */
function geminiPlan(meta: ProjectMeta): BootstrapPlan {
  return {
    agentLabel: AGENT_LABELS.gemini,
    agentDir: '.gemini',
    docsUrl: 'https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html',
    folders: ['.gemini', '.gemini/commands', RUNOVA_DIR],
    files: [
      {
        relativePath: 'GEMINI.md',
        content: `# ${meta.name}

Context file for Gemini CLI. Loaded at the start of every session.

${instructionsBody(meta)}
## Layout

- \`.gemini/settings.json\`: workspace settings (overrides \`~/.gemini/settings.json\`).
- \`.gemini/commands/\`: custom slash commands as TOML; \`git/commit.toml\` becomes \`/git:commit\`.

Docs: https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html
`,
      },
      {
        relativePath: '.gemini/settings.json',
        content: `${JSON.stringify(
          {
            context: { fileName: ['GEMINI.md'] },
            mcpServers: {},
          },
          null,
          2,
        )}\n`,
      },
      {
        relativePath: '.gemini/commands/review-diff.toml',
        content: `description = "Review the uncommitted changes in this repository"

prompt = """
${REVIEW_DIFF_PROMPT}
"""
`,
      },
      ...runovaDocs(meta),
    ],
  };
}

/**
 * Codex CLI: https://developers.openai.com/codex/config-advanced
 * `AGENTS.md` at the root, project-scoped config and skills under `.codex/`.
 * Project-scoped layers are only read once the project is trusted.
 */
function codexPlan(meta: ProjectMeta): BootstrapPlan {
  return {
    agentLabel: AGENT_LABELS.codex,
    agentDir: '.codex',
    docsUrl: 'https://developers.openai.com/codex/config-advanced',
    folders: ['.codex', '.codex/skills', RUNOVA_DIR],
    files: [
      agentsMd(
        meta,
        AGENT_LABELS.codex,
        `## Layout

- \`.codex/config.toml\`: project-scoped overrides, merged with \`~/.codex/config.toml\` (nearest file wins).
- \`.codex/skills/<name>/SKILL.md\`: skills, loaded on demand.

Codex only reads \`.codex/\` once you trust this project.

Docs: https://developers.openai.com/codex/config-advanced
`,
      ),
      {
        relativePath: '.codex/config.toml',
        content: `# Project-scoped Codex configuration.
# Merged with ~/.codex/config.toml; the file closest to your working directory wins.
# Credentials, provider auth and profile selection can only be set at user level.
# Docs: https://developers.openai.com/codex/config-advanced

# model = "${CODEX_CONFIG_EXAMPLE_MODEL}"
# approval_policy = "on-request"
# sandbox_mode = "workspace-write"
`,
      },
      gitkeep('.codex/skills'),
      ...runovaDocs(meta),
    ],
  };
}

/**
 * opencode: https://opencode.ai/docs/config/
 * `AGENTS.md` plus `opencode.json` at the root; agents, commands, plugins and
 * tools under `.opencode/` (plural names; singular still works).
 */
function opencodePlan(meta: ProjectMeta): BootstrapPlan {
  return {
    agentLabel: AGENT_LABELS.opencode,
    agentDir: '.opencode',
    docsUrl: 'https://opencode.ai/docs/config/',
    folders: ['.opencode', '.opencode/agents', '.opencode/commands', RUNOVA_DIR],
    files: [
      agentsMd(
        meta,
        AGENT_LABELS.opencode,
        `## Layout

- \`opencode.json\`: project config; overrides global and remote settings.
- \`.opencode/agents/<name>.md\`: custom agents (YAML frontmatter + system prompt).
- \`.opencode/commands/<name>.md\`: custom command templates.

Docs: https://opencode.ai/docs/config/
`,
      ),
      {
        relativePath: 'opencode.json',
        content: `${JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2)}\n`,
      },
      {
        relativePath: '.opencode/commands/review-diff.md',
        content: `---
description: Review the uncommitted changes in this repository
---

${REVIEW_DIFF_PROMPT}
`,
      },
      gitkeep('.opencode/agents'),
      ...runovaDocs(meta),
    ],
  };
}

/**
 * Cursor: https://cursor.com/docs/context/rules
 * `AGENTS.md` at the root, MDC rules and command prompts under `.cursor/`.
 */
function cursorPlan(meta: ProjectMeta): BootstrapPlan {
  return {
    agentLabel: AGENT_LABELS.cursor,
    agentDir: '.cursor',
    docsUrl: 'https://cursor.com/docs/context/rules',
    folders: ['.cursor', '.cursor/rules', '.cursor/commands', RUNOVA_DIR],
    files: [
      agentsMd(
        meta,
        AGENT_LABELS.cursor,
        `## Layout

- \`.cursor/rules/<name>.mdc\`: rules with \`description\`/\`globs\`/\`alwaysApply\` frontmatter.
- \`.cursor/commands/<name>.md\`: reusable prompts invoked as \`/<name>\`.

Docs: https://cursor.com/docs/context/rules
`,
      ),
      {
        relativePath: '.cursor/rules/project-conventions.mdc',
        content: `---
description: Baseline conventions for this project
globs:
alwaysApply: true
---

- Match the style of surrounding code; don't reformat unrelated lines.
- Prefer small, reviewable changes.
- Add or update tests alongside behavior changes.

Set \`globs\` (e.g. \`src/**/*.tsx\`) and \`alwaysApply: false\` to scope a rule to
matching files instead of every session.
`,
      },
      {
        relativePath: '.cursor/commands/review-diff.md',
        content: `${REVIEW_DIFF_PROMPT}\n`,
      },
      ...runovaDocs(meta),
    ],
  };
}

/** No dedicated agent folder, just the `AGENTS.md` open standard. */
function genericPlan(meta: ProjectMeta): BootstrapPlan {
  return {
    agentLabel: AGENT_LABELS.generic,
    agentDir: '',
    docsUrl: 'https://agents.md',
    folders: [RUNOVA_DIR],
    files: [
      agentsMd(
        meta,
        AGENT_LABELS.generic,
        `Most coding agents read \`AGENTS.md\` from the repository root. Docs: https://agents.md
`,
      ),
      ...runovaDocs(meta),
    ],
  };
}

const PLANNERS: Record<AgentType, (meta: ProjectMeta) => BootstrapPlan> = {
  'claude-code': claudeCodePlan,
  gemini: geminiPlan,
  codex: codexPlan,
  opencode: opencodePlan,
  cursor: cursorPlan,
  generic: genericPlan,
};

/** Returns the folders and files to scaffold for a project, per its agent's own conventions. */
export function getBootstrapPlan(meta: ProjectMeta): BootstrapPlan {
  return (PLANNERS[meta.agentType] ?? genericPlan)(meta);
}
