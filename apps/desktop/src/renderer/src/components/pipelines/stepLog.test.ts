import type { GithubLogLine, GithubStepLog } from '@shared/apiTypes';
import { describe, expect, it } from 'vitest';
import { stepFixExcerpt, stepLogText } from './stepLog';

function plain(count: number, from = 1): GithubLogLine[] {
  return Array.from({ length: count }, (_, i) => ({ text: `line ${from + i}`, kind: 'plain' }));
}

function stepLog(lines: GithubLogLine[]): GithubStepLog {
  return {
    number: 4,
    lines,
    errors: lines.filter((line) => line.kind === 'error').length,
    warnings: lines.filter((line) => line.kind === 'warning').length,
  };
}

describe('stepLogText', () => {
  it('joins the lines as plain text, the way they read in the panel', () => {
    const log = stepLog([
      { text: 'Run pnpm test', kind: 'group' },
      { text: '/usr/bin/pnpm test', kind: 'command' },
      { text: '1 test failed', kind: 'error' },
    ]);
    expect(stepLogText(log)).toBe('Run pnpm test\n/usr/bin/pnpm test\n1 test failed');
  });

  it('is empty for a step that printed nothing', () => {
    expect(stepLogText(stepLog([]))).toBe('');
  });
});

describe('stepFixExcerpt', () => {
  it('hands over a short log whole, with errors and warnings marked', () => {
    const log = stepLog([
      { text: 'Run pnpm lint', kind: 'group' },
      { text: 'Unused variable x', kind: 'warning' },
      { text: 'Process completed with exit code 1.', kind: 'error' },
    ]);
    expect(stepFixExcerpt(log)).toBe(
      [
        'Run pnpm lint',
        '[warning] Unused variable x',
        '[error] Process completed with exit code 1.',
      ].join('\n'),
    );
  });

  it('keeps each error with a few lines around it, then the end of the log', () => {
    const lines = [
      ...plain(50),
      { text: 'TypeError: x is undefined', kind: 'error' as const },
      ...plain(200, 51),
    ];

    const excerpt = stepFixExcerpt(stepLog(lines), { context: 2, tail: 3 }).split('\n');

    expect(excerpt).toEqual([
      '...',
      'line 49',
      'line 50',
      '[error] TypeError: x is undefined',
      'line 51',
      'line 52',
      '...',
      'line 248',
      'line 249',
      'line 250',
    ]);
  });

  it('does not repeat lines where an error sits inside the end of the log', () => {
    const lines = [...plain(5), { text: 'boom', kind: 'error' as const }, ...plain(2, 6)];
    const excerpt = stepFixExcerpt(stepLog(lines), { context: 1, tail: 3 }).split('\n');
    expect(excerpt).toEqual(['...', 'line 5', '[error] boom', 'line 6', 'line 7']);
  });

  it('stays under the size cap by dropping the start, since the end holds the outcome', () => {
    const lines = plain(500);
    const excerpt = stepFixExcerpt(stepLog(lines), { tail: 500, cap: 100 });
    expect(excerpt.length).toBeLessThanOrEqual(104);
    expect(excerpt.startsWith('...\n')).toBe(true);
    expect(excerpt.endsWith('line 500')).toBe(true);
  });
});
