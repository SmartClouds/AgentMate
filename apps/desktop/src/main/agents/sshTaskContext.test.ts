import { describe, expect, it } from 'vitest';
import type { SshAgentHistoryEntry, SshAgentHistoryRun } from '../../shared/apiTypes';
import { MAX_PREVIOUS_CONTEXT_CHARS, previousTaskContext } from './sshTaskContext';

function run(
  id: string,
  prompt: string,
  entries: SshAgentHistoryEntry[],
  extra: Partial<SshAgentHistoryRun> = {},
): SshAgentHistoryRun {
  return {
    id,
    sessionId: 's1',
    prompt,
    aiLabel: 'Gemini',
    startedAt: 1,
    endedAt: 2,
    status: 'finished',
    entries,
    ...extra,
  };
}

const at = 0;

describe('previousTaskContext', () => {
  it('tells the AI what the earlier task was and everything that happened in it', () => {
    const text = previousTaskContext([
      run('a', 'free up disk space', [
        {
          kind: 'command',
          at,
          command: 'df -h /',
          output: '/dev/sda1  20G  19G  95% /',
          exitCode: 0,
          timedOut: false,
        },
        { kind: 'question', at, text: 'Delete the old journal logs too?' },
        { kind: 'answer', at, text: 'yes' },
        { kind: 'message', at, text: 'keep the last week' },
        { kind: 'skipped', at, command: 'rm -rf /var/log/*' },
        {
          kind: 'command',
          at,
          command: 'journalctl --vacuum-time=7d',
          output: 'Freed 1.2G',
          exitCode: 0,
          timedOut: false,
        },
        { kind: 'finished', at, text: 'Freed 1.2 GB of journal logs.' },
      ]),
    ]);
    expect(text).toContain('Earlier task: "free up disk space"');
    expect(text).toContain('$ df -h / [exit code 0]\n/dev/sda1  20G  19G  95% /');
    expect(text).toContain('[The AI asked]: Delete the old journal logs too?');
    expect(text).toContain('[You answered]: yes');
    expect(text).toContain('[You said]: keep the last week');
    expect(text).toContain('[Skipped by you, not run]: rm -rf /var/log/*');
    expect(text).toContain('[Finished]: Freed 1.2 GB of journal logs.');
  });

  it('says how a task that did not finish ended', () => {
    const stopped = previousTaskContext([
      run('a', 'x', [{ kind: 'stopped', at, text: 'Stopped by you.' }], { status: 'stopped' }),
    ]);
    expect(stopped).toContain('[Stopped]: Stopped by you.');
    const failed = previousTaskContext([
      run('a', 'x', [{ kind: 'error', at, text: 'Paused: the AI did not answer.' }], {
        status: 'error',
      }),
    ]);
    expect(failed).toContain('[Error]: Paused: the AI did not answer.');
  });

  it('marks a command that timed out or never reported its exit', () => {
    const text = previousTaskContext([
      run('a', 'x', [
        { kind: 'command', at, command: 'tail -f log', output: '', exitCode: null, timedOut: true },
      ]),
    ]);
    expect(text).toContain('$ tail -f log [timed out]');
  });

  it('walks a chain of continued tasks, oldest first', () => {
    const text = previousTaskContext([
      run('a', 'install nginx', [{ kind: 'finished', at, text: 'Installed.' }]),
      run('b', 'now enable https', [{ kind: 'finished', at, text: 'Enabled.' }], {
        continuedFromRunId: 'a',
      }),
    ]);
    expect(text.indexOf('install nginx')).toBeLessThan(text.indexOf('now enable https'));
  });

  it('keeps the newest part when there is too much, and says the start was cut', () => {
    // Each output is cut to its end first, so it takes many commands to pass the cap.
    const commands = Array.from({ length: 20 }, (_, i) => ({
      kind: 'command' as const,
      at,
      command: `step-${i}`,
      output: 'x'.repeat(1000),
      exitCode: 0,
      timedOut: false,
    }));
    const text = previousTaskContext([
      run('a', 'first', [...commands, { kind: 'finished', at, text: 'The very end.' }]),
    ]);
    expect(text).not.toContain('step-0 ');
    expect(text.length).toBeLessThanOrEqual(MAX_PREVIOUS_CONTEXT_CHARS + 200);
    expect(text).toContain('The very end.');
    expect(text).toContain('(earlier part cut)');
  });

  it('trims a long output to its end, which says how the command went', () => {
    const output = `${'noise\n'.repeat(400)}DONE: 3 errors`;
    const text = previousTaskContext([
      run('a', 'x', [
        { kind: 'command', at, command: 'make', output, exitCode: 2, timedOut: false },
      ]),
    ]);
    expect(text).toContain('DONE: 3 errors');
    expect(text).toContain('(output trimmed)');
  });

  it('keeps the start of a long answer, so one answer does not crowd out the rest', () => {
    const answer = `The short version: memory.\n${'detail '.repeat(800)}`;
    const text = previousTaskContext([run('a', 'x', [{ kind: 'finished', at, text: answer }])]);
    expect(text).toContain('[Finished]: The short version: memory.');
    expect(text).toContain('(answer trimmed)');
    expect(text.length).toBeLessThan(2000);
  });

  it('keeps Persian as it was written', () => {
    const text = previousTaskContext([
      run('a', 'لاگ‌ها را پاک کن', [{ kind: 'answer', at, text: 'بله' }]),
    ]);
    expect(text).toContain('Earlier task: "لاگ‌ها را پاک کن"');
    expect(text).toContain('[You answered]: بله');
  });

  it('is empty without an earlier task', () => {
    expect(previousTaskContext([])).toBe('');
  });
});
