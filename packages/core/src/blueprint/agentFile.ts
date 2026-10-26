import type { AgentType, BlueprintStepId } from '../types/index.js';
import { blueprintStep } from './steps.js';

/**
 * Where each agent reads its project instructions from. The first entry is the
 * one Runova's own bootstrap writes; the rest are places the same agent also
 * reads, accepted when a repo that came from somewhere else already has one.
 *
 * Kept in step with `projectBootstrap/templates.ts`, which writes
 * `.claude/CLAUDE.md`, `GEMINI.md`, and `AGENTS.md` for everything else.
 */
export const AGENT_INSTRUCTION_FILES: Record<AgentType, string[]> = {
  'claude-code': ['.claude/CLAUDE.md', 'CLAUDE.md'],
  gemini: ['GEMINI.md', '.gemini/GEMINI.md'],
  codex: ['AGENTS.md'],
  opencode: ['AGENTS.md'],
  cursor: ['AGENTS.md'],
  generic: ['AGENTS.md'],
};

export const BLUEPRINT_BLOCK_START = '<!-- runova:blueprint:start -->';
export const BLUEPRINT_BLOCK_END = '<!-- runova:blueprint:end -->';

export interface BlueprintBlockSection {
  stepId: BlueprintStepId;
  text: string;
}

/**
 * The body that goes between the markers. Empty when nothing is ticked, which
 * is the signal for `applyManagedBlock` to remove the block entirely.
 */
export function renderBlueprintBlock(sections: BlueprintBlockSection[]): string {
  const parts = sections
    .filter((section) => section.text.trim().length > 0)
    .map((section) => `### ${blueprintStep(section.stepId).heading}\n\n${section.text.trim()}`);
  if (parts.length === 0) return '';
  return [
    '## Project blueprint',
    '',
    '<!-- Maintained by Runova. Anything written inside this block is overwritten. -->',
    '',
    parts.join('\n\n'),
  ].join('\n');
}

/**
 * Puts `body` into the file's managed block, replacing whatever was there.
 *
 * One block for the whole blueprint rather than one per section: six sets of
 * markers would have to be found, reordered and cleaned up individually, and an
 * unticked section would leave its markers behind with nothing between them.
 *
 * A file whose markers are malformed (only one of them, or the end before the
 * start) is treated as having no block at all and gets a fresh one appended.
 * Guessing at a repair on a file the user also edits by hand is the worse
 * failure of the two.
 */
export function applyManagedBlock(fileText: string, body: string): string {
  const trimmedBody = body.trim();
  const block = trimmedBody
    ? `${BLUEPRINT_BLOCK_START}\n${trimmedBody}\n${BLUEPRINT_BLOCK_END}`
    : '';

  const start = fileText.indexOf(BLUEPRINT_BLOCK_START);
  const end = fileText.indexOf(BLUEPRINT_BLOCK_END);

  if (start !== -1 && end > start) {
    const before = fileText.slice(0, start);
    const after = fileText.slice(end + BLUEPRINT_BLOCK_END.length);
    if (!block) {
      // Removing the block shouldn't leave a run of blank lines where it was, or
      // a longer tail than the file had before it was ever written to.
      const joined = `${before}${after}`.replace(/\n{3,}/g, '\n\n');
      return joined.trim() ? `${joined.replace(/\s*$/, '')}\n` : '';
    }
    return `${before}${block}${after}`;
  }

  if (!block) return fileText;
  if (!fileText.trim()) return `${block}\n`;
  return `${fileText.replace(/\s*$/, '')}\n\n${block}\n`;
}
