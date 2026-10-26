import { describe, expect, it } from 'vitest';
import type { AgentType } from '../types/index.js';
import { getBootstrapPlan, type ProjectMeta, RUNOVA_DIR } from './templates.js';

/**
 * Every path in a plan is joined onto the project folder and written through the
 * sandboxed fs IPC, so an absolute path or one that climbs out would either be
 * rejected at write time or land somewhere the user never agreed to. The templates
 * themselves are written into a repository the user keeps, so a leftover `${}` or an
 * `undefined` in the text is a visible defect.
 */

const ALL_AGENT_TYPES: AgentType[] = [
  'claude-code',
  'gemini',
  'opencode',
  'codex',
  'cursor',
  'generic',
];

function meta(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return {
    name: 'My App',
    description: 'A small app for tracking habits.',
    agentType: 'claude-code',
    ...overrides,
  };
}

describe('getBootstrapPlan', () => {
  it('produces a plan for every agent type', () => {
    for (const agentType of ALL_AGENT_TYPES) {
      const plan = getBootstrapPlan(meta({ agentType }));
      expect(plan.agentLabel.trim(), agentType).not.toBe('');
      expect(plan.docsUrl, agentType).toMatch(/^https:\/\/\S+$/);
      expect(plan.folders.length, agentType).toBeGreaterThan(0);
      expect(plan.files.length, agentType).toBeGreaterThan(0);
    }
  });

  it("creates Runova's own folder and docs for every agent type", () => {
    for (const agentType of ALL_AGENT_TYPES) {
      const plan = getBootstrapPlan(meta({ agentType }));
      expect(plan.folders, agentType).toContain(RUNOVA_DIR);
      const paths = plan.files.map((file) => file.relativePath);
      expect(paths, agentType).toContain(`${RUNOVA_DIR}/PROJECT_CONTEXT.md`);
      expect(paths, agentType).toContain(`${RUNOVA_DIR}/ROADMAP.md`);
    }
  });

  it('falls back to the generic plan for an agent type it does not know', () => {
    const unknown = getBootstrapPlan(meta({ agentType: 'brand-new-agent' as AgentType }));
    const generic = getBootstrapPlan(meta({ agentType: 'generic' }));
    expect(unknown.files.map((f) => f.relativePath)).toEqual(
      generic.files.map((f) => f.relativePath),
    );
  });

  it('writes the instruction file each agent actually reads', () => {
    const expected: Record<AgentType, string> = {
      'claude-code': '.claude/CLAUDE.md',
      gemini: 'GEMINI.md',
      codex: 'AGENTS.md',
      opencode: 'AGENTS.md',
      cursor: 'AGENTS.md',
      generic: 'AGENTS.md',
    };
    for (const agentType of ALL_AGENT_TYPES) {
      const paths = getBootstrapPlan(meta({ agentType })).files.map((f) => f.relativePath);
      expect(paths, agentType).toContain(expected[agentType]);
    }
  });

  it('only names an agent dir it also creates', () => {
    for (const agentType of ALL_AGENT_TYPES) {
      const plan = getBootstrapPlan(meta({ agentType }));
      if (!plan.agentDir) continue;
      expect(plan.folders, agentType).toContain(plan.agentDir);
    }
  });
});

describe('plan paths', () => {
  it('are relative, posix-separated and never climb out of the project', () => {
    for (const agentType of ALL_AGENT_TYPES) {
      const plan = getBootstrapPlan(meta({ agentType }));
      for (const path of [...plan.folders, ...plan.files.map((f) => f.relativePath)]) {
        expect(path, `${agentType}: ${path}`).not.toBe('');
        expect(path, `${agentType}: ${path}`).not.toContain('\\');
        expect(path, `${agentType}: ${path}`).not.toMatch(/^[/\\]/);
        expect(path, `${agentType}: ${path}`).not.toMatch(/^[a-zA-Z]:/);
        expect(path.split('/'), `${agentType}: ${path}`).not.toContain('..');
        expect(path, `${agentType}: ${path}`).not.toMatch(/\/$/);
      }
    }
  });

  it('never write the same file twice in one plan', () => {
    for (const agentType of ALL_AGENT_TYPES) {
      const paths = getBootstrapPlan(meta({ agentType })).files.map((f) => f.relativePath);
      const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index);
      expect(duplicates, agentType).toEqual([]);
    }
  });

  it('put every nested file under a folder the plan creates', () => {
    for (const agentType of ALL_AGENT_TYPES) {
      const plan = getBootstrapPlan(meta({ agentType }));
      const folders = new Set(plan.folders);
      for (const file of plan.files) {
        const parent = file.relativePath.split('/').slice(0, -1).join('/');
        if (!parent) continue;
        expect(folders.has(parent), `${agentType}: ${file.relativePath}`).toBe(true);
      }
    }
  });

  it('never list the same folder twice', () => {
    for (const agentType of ALL_AGENT_TYPES) {
      const folders = getBootstrapPlan(meta({ agentType })).folders;
      expect(new Set(folders).size, agentType).toBe(folders.length);
    }
  });
});

describe('rendered templates', () => {
  it('leave no unresolved placeholder or undefined in any file', () => {
    for (const agentType of ALL_AGENT_TYPES) {
      for (const file of getBootstrapPlan(meta({ agentType })).files) {
        const where = `${agentType}: ${file.relativePath}`;
        expect(file.content, where).not.toContain('undefined');
        expect(file.content, where).not.toContain('[object Object]');
        // An unrendered template literal or a mustache placeholder left behind.
        expect(file.content, where).not.toMatch(/\$\{[^}]*\}/);
        expect(file.content, where).not.toMatch(/\{\{[^}]*\}\}/);
      }
    }
  });

  it('end every non-empty file with exactly one newline', () => {
    for (const agentType of ALL_AGENT_TYPES) {
      for (const file of getBootstrapPlan(meta({ agentType })).files) {
        const where = `${agentType}: ${file.relativePath}`;
        if (file.content === '') continue;
        expect(file.content.endsWith('\n'), where).toBe(true);
        expect(file.content.endsWith('\n\n'), where).toBe(false);
      }
    }
  });

  it('carry the project name and description into the docs', () => {
    const project = meta({ name: 'Habit Tracker', description: 'Tracks daily habits.' });
    for (const agentType of ALL_AGENT_TYPES) {
      const files = getBootstrapPlan({ ...project, agentType }).files;
      const context = files.find((f) => f.relativePath === `${RUNOVA_DIR}/PROJECT_CONTEXT.md`);
      expect(context?.content, agentType).toContain('Habit Tracker');
      expect(context?.content, agentType).toContain('Tracks daily habits.');
    }
  });

  it('substitute a prompt for a missing description rather than leaving a blank section', () => {
    const files = getBootstrapPlan(meta({ description: '' })).files;
    const context = files.find((f) => f.relativePath === `${RUNOVA_DIR}/PROJECT_CONTEXT.md`);
    expect(context?.content).toContain('_(describe what this project does)_');
  });

  it('name the agent in its own instruction file', () => {
    const plan = getBootstrapPlan(meta({ agentType: 'cursor' }));
    const agents = plan.files.find((f) => f.relativePath === 'AGENTS.md');
    expect(agents?.content).toContain(plan.agentLabel);
  });

  it('keep every JSON file parseable', () => {
    for (const agentType of ALL_AGENT_TYPES) {
      for (const file of getBootstrapPlan(meta({ agentType })).files) {
        if (!file.relativePath.endsWith('.json')) continue;
        expect(() => JSON.parse(file.content), `${agentType}: ${file.relativePath}`).not.toThrow();
      }
    }
  });

  it('survive a project name with characters that would break a template', () => {
    const plan = getBootstrapPlan(
      meta({ name: '`My` ${App} "quoted" \\slash', description: 'Line one\nLine two' }),
    );
    for (const file of plan.files) {
      expect(file.content, file.relativePath).not.toContain('undefined');
    }
    const context = plan.files.find((f) => f.relativePath === `${RUNOVA_DIR}/PROJECT_CONTEXT.md`);
    expect(context?.content).toContain('`My` ${App} "quoted" \\slash');
  });

  it('is deterministic, so re-running bootstrap produces the same files', () => {
    for (const agentType of ALL_AGENT_TYPES) {
      expect(getBootstrapPlan(meta({ agentType })), agentType).toEqual(
        getBootstrapPlan(meta({ agentType })),
      );
    }
  });
});
