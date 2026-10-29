import type { GithubLogLine, GithubStepLog } from '@shared/apiTypes';

/** A step's log as plain text, the way it reads in the panel. */
export function stepLogText(log: GithubStepLog): string {
  return log.lines.map((line) => line.text).join('\n');
}

function excerptLine(line: GithubLogLine): string {
  if (line.kind === 'error') return `[error] ${line.text}`;
  if (line.kind === 'warning') return `[warning] ${line.text}`;
  return line.text;
}

/**
 * The part of a step's log an agent needs to fix it: every error and warning with a few lines
 * around it, then the end of the log, where the outcome is. Gaps show as "...". Past `cap`
 * characters the start goes, so the excerpt fits in a prompt.
 */
export function stepFixExcerpt(
  log: GithubStepLog,
  { context = 3, tail = 80, cap = 12_000 }: { context?: number; tail?: number; cap?: number } = {},
): string {
  const { lines } = log;
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind !== 'error' && line.kind !== 'warning') return;
    for (
      let i = Math.max(0, index - context);
      i <= Math.min(lines.length - 1, index + context);
      i++
    ) {
      keep.add(i);
    }
  });
  for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) keep.add(i);

  const out: string[] = [];
  let previous = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index > previous + 1) out.push('...');
    out.push(excerptLine(lines[index]));
    previous = index;
  }

  const text = out.join('\n');
  if (text.length <= cap) return text;
  const end = text.slice(-cap);
  // Start on a whole line rather than halfway through one.
  return `...\n${end.slice(end.indexOf('\n') + 1)}`;
}
