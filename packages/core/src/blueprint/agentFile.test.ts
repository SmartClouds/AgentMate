import { describe, expect, it } from 'vitest';
import type { AgentType } from '../types/index.js';
import {
  AGENT_INSTRUCTION_FILES,
  applyManagedBlock,
  BLUEPRINT_BLOCK_END,
  BLUEPRINT_BLOCK_START,
  renderBlueprintBlock,
} from './agentFile.js';
import { blueprintStep } from './steps.js';

/**
 * This writes into a file the user also edits by hand (CLAUDE.md, AGENTS.md), so the
 * managed block has to be replaced in place and removed cleanly, and a file with
 * malformed markers is left alone rather than repaired by guesswork.
 */

const ALL_AGENT_TYPES: AgentType[] = [
  'claude-code',
  'gemini',
  'opencode',
  'codex',
  'cursor',
  'generic',
];

describe('AGENT_INSTRUCTION_FILES', () => {
  it('names at least one file for every agent type', () => {
    expect(Object.keys(AGENT_INSTRUCTION_FILES).sort()).toEqual([...ALL_AGENT_TYPES].sort());
    for (const type of ALL_AGENT_TYPES) {
      expect(AGENT_INSTRUCTION_FILES[type].length, type).toBeGreaterThan(0);
    }
  });

  it('lists only relative, posix-separated markdown paths', () => {
    for (const type of ALL_AGENT_TYPES) {
      for (const path of AGENT_INSTRUCTION_FILES[type]) {
        expect(path, `${type}: ${path}`).toMatch(/\.md$/);
        expect(path, `${type}: ${path}`).not.toContain('\\');
        expect(path, `${type}: ${path}`).not.toMatch(/^[/\\]/);
        expect(path.split('/'), `${type}: ${path}`).not.toContain('..');
      }
    }
  });

  it('never lists the same path twice for one agent', () => {
    for (const type of ALL_AGENT_TYPES) {
      const paths = AGENT_INSTRUCTION_FILES[type];
      expect(new Set(paths).size, type).toBe(paths.length);
    }
  });

  it("puts the file Runova's own bootstrap writes first", () => {
    // The rest are only accepted when a repo from elsewhere already has one.
    expect(AGENT_INSTRUCTION_FILES['claude-code'][0]).toBe('.claude/CLAUDE.md');
    expect(AGENT_INSTRUCTION_FILES.gemini[0]).toBe('GEMINI.md');
    expect(AGENT_INSTRUCTION_FILES.generic[0]).toBe('AGENTS.md');
  });
});

describe('renderBlueprintBlock', () => {
  it('renders each ticked section under its own step heading', () => {
    expect(
      renderBlueprintBlock([
        { stepId: 'idea', text: 'A habit tracker.' },
        { stepId: 'backend', text: 'Fastify and Postgres.' },
      ]),
    ).toMatchInlineSnapshot(`
      "## Project blueprint

      <!-- Maintained by Runova. Anything written inside this block is overwritten. -->

      ### Main idea

      A habit tracker.

      ### Backend

      Fastify and Postgres."
    `);
  });

  it('uses the heading from the step table rather than a second spelling', () => {
    const body = renderBlueprintBlock([{ stepId: 'quality', text: 'Tests are blocking.' }]);
    expect(body).toContain(`### ${blueprintStep('quality').heading}`);
  });

  it('skips empty sections and trims the text it keeps', () => {
    const body = renderBlueprintBlock([
      { stepId: 'idea', text: '  padded  ' },
      { stepId: 'backend', text: '   ' },
      { stepId: 'frontend', text: '\n\n' },
    ]);
    expect(body).toContain('padded');
    expect(body).not.toContain('  padded');
    expect(body).not.toContain(blueprintStep('backend').heading);
  });

  it("returns '' when nothing is ticked, which is the signal to remove the block", () => {
    expect(renderBlueprintBlock([])).toBe('');
    expect(renderBlueprintBlock([{ stepId: 'idea', text: '   ' }])).toBe('');
  });
});

describe('applyManagedBlock', () => {
  const body = 'hello';
  const block = `${BLUEPRINT_BLOCK_START}\n${body}\n${BLUEPRINT_BLOCK_END}`;

  it('appends a block to a file that has none, keeping one blank line between', () => {
    expect(applyManagedBlock('# Project\n\nSome notes.\n', body)).toBe(
      `# Project\n\nSome notes.\n\n${block}\n`,
    );
  });

  it('writes just the block into an empty or whitespace-only file', () => {
    expect(applyManagedBlock('', body)).toBe(`${block}\n`);
    expect(applyManagedBlock('\n\n  \n', body)).toBe(`${block}\n`);
  });

  it('replaces what was between the markers, leaving the rest of the file alone', () => {
    const existing = `# Project\n\n${BLUEPRINT_BLOCK_START}\nold text\n${BLUEPRINT_BLOCK_END}\n\nHand-written tail.\n`;
    expect(applyManagedBlock(existing, 'new text')).toBe(
      `# Project\n\n${BLUEPRINT_BLOCK_START}\nnew text\n${BLUEPRINT_BLOCK_END}\n\nHand-written tail.\n`,
    );
  });

  it('trims the body it is given, so the markers always hug the content', () => {
    expect(applyManagedBlock('', '\n\n  hello  \n\n')).toBe(`${block}\n`);
  });

  it('removes the block on an empty body and does not leave a run of blank lines', () => {
    const existing = `# Project\n\n${BLUEPRINT_BLOCK_START}\nold\n${BLUEPRINT_BLOCK_END}\n\nTail.\n`;
    expect(applyManagedBlock(existing, '')).toBe('# Project\n\nTail.\n');
  });

  it('empties a file that was nothing but the block', () => {
    expect(applyManagedBlock(`${block}\n`, '')).toBe('');
  });

  it('leaves a file with no block untouched when there is nothing to write', () => {
    const existing = '# Project\n\nSome notes.\n';
    expect(applyManagedBlock(existing, '')).toBe(existing);
    expect(applyManagedBlock('', '')).toBe('');
  });

  it('appends a fresh block when the markers are malformed', () => {
    // Guessing at a repair on a file the user also edits by hand is the worse failure.
    const onlyStart = `# Project\n\n${BLUEPRINT_BLOCK_START}\nhalf written\n`;
    expect(applyManagedBlock(onlyStart, body)).toBe(
      `${onlyStart.replace(/\s*$/, '')}\n\n${block}\n`,
    );

    const reversed = `${BLUEPRINT_BLOCK_END}\nbackwards\n${BLUEPRINT_BLOCK_START}\n`;
    expect(applyManagedBlock(reversed, body)).toContain(block);
  });

  it('leaves a file with malformed markers alone when there is nothing to write', () => {
    const onlyEnd = `# Project\n${BLUEPRINT_BLOCK_END}\n`;
    expect(applyManagedBlock(onlyEnd, '')).toBe(onlyEnd);
  });

  it('is idempotent: writing the same body twice changes nothing the second time', () => {
    const once = applyManagedBlock('# Project\n', body);
    expect(applyManagedBlock(once, body)).toBe(once);
  });

  it('round trips a render into a file and back out again', () => {
    const rendered = renderBlueprintBlock([{ stepId: 'idea', text: 'A habit tracker.' }]);
    const file = applyManagedBlock('# Project\n', rendered);
    expect(file).toContain('A habit tracker.');
    // Removing it again gets the original file back.
    expect(applyManagedBlock(file, '')).toBe('# Project\n');
  });
});
