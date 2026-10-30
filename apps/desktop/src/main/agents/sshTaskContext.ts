import type { SshAgentHistoryEntry, SshAgentHistoryRun } from '../../shared/apiTypes';

/** How much of the earlier tasks a continued task is told about. The newest part is kept. */
export const MAX_PREVIOUS_CONTEXT_CHARS = 6000;
/** The end of each command's output, which is what says how it went. */
const OUTPUT_TAIL_CHARS = 600;
/** The start of a long answer, which is where it says what was found. */
const ANSWER_HEAD_CHARS = 1500;

function answerHead(text: string): string {
  if (text.length <= ANSWER_HEAD_CHARS) return text;
  return `${text.slice(0, ANSWER_HEAD_CHARS).trimEnd()}\n(answer trimmed)`;
}

function outputTail(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= OUTPUT_TAIL_CHARS) return trimmed;
  return `(output trimmed)\n${trimmed.slice(-OUTPUT_TAIL_CHARS)}`;
}

function entryLine(entry: SshAgentHistoryEntry): string | null {
  switch (entry.kind) {
    case 'command': {
      const note = entry.timedOut
        ? ' [timed out]'
        : entry.exitCode !== null
          ? ` [exit code ${entry.exitCode}]`
          : '';
      const output = outputTail(entry.output);
      return `$ ${entry.command}${note}${output ? `\n${output}` : ''}`;
    }
    case 'skipped':
      return `[Skipped by you, not run]: ${entry.command}`;
    case 'question':
      return `[The AI asked]: ${entry.text}`;
    case 'answer':
      return `[You answered]: ${entry.text}`;
    case 'message':
      return `[You said]: ${entry.text}`;
    case 'error':
      return `[Error]: ${entry.text}`;
    case 'finished':
      return `[Finished]: ${answerHead(entry.text)}`;
    case 'stopped':
      return `[Stopped]: ${entry.text}`;
    case 'continued':
      return null;
  }
}

/**
 * What a continued task is told about the tasks before it, oldest first: each prompt, the
 * commands with how they ended, what the user said, and how the task ended. Capped, with the
 * newest part kept, since that is where the next step picks up.
 */
export function previousTaskContext(chain: SshAgentHistoryRun[]): string {
  if (chain.length === 0) return '';
  const body = chain
    .map((run) => {
      const lines = run.entries.map(entryLine).filter((line): line is string => line !== null);
      return [`Earlier task: "${run.prompt}"`, ...lines].join('\n');
    })
    .join('\n\n');
  const kept =
    body.length > MAX_PREVIOUS_CONTEXT_CHARS
      ? `(earlier part cut)\n${body.slice(-MAX_PREVIOUS_CONTEXT_CHARS)}`
      : body;
  return `This continues earlier work in this same session. What happened then, oldest first:\n${kept}`;
}
