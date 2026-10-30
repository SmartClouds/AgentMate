import type { SshAgentHistoryRun } from '@shared/apiTypes';
import { describe, expect, it } from 'vitest';
import { runFromChain } from './historyTurns';

function run(id: string, extra: Partial<SshAgentHistoryRun>): SshAgentHistoryRun {
  return {
    id,
    sessionId: 'deploy:srv-1',
    serverId: 'srv-1',
    scope: 'deploy',
    prompt: `prompt ${id}`,
    aiLabel: 'Ollama',
    startedAt: 1,
    endedAt: 2,
    status: 'finished',
    entries: [],
    ...extra,
  };
}

describe('runFromChain', () => {
  it('turns each command into a step with its output, and a skip into a skipped step', () => {
    const shown = runFromChain([
      run('r1', {
        prompt: 'What runs here?',
        entries: [
          {
            kind: 'command',
            at: 1,
            command: 'docker ps',
            output: 'web\ndb\n',
            exitCode: 0,
            timedOut: false,
          },
          { kind: 'skipped', at: 2, command: 'rm -rf /tmp/x' },
          { kind: 'finished', at: 3, text: 'Two containers.' },
        ],
      }),
    ]);
    expect(shown.prompt).toBe('What runs here?');
    expect(shown.earlier).toEqual([]);
    expect(shown.steps).toEqual([
      {
        step: 1,
        command: 'docker ps',
        status: 'done',
        lines: [
          { stream: 'out', text: 'web' },
          { stream: 'out', text: 'db' },
        ],
      },
      { step: 2, command: 'rm -rf /tmp/x', status: 'skipped', lines: [] },
    ]);
    expect(shown.progress).toMatchObject({
      phase: 'finished',
      message: 'Two containers.',
      step: 2,
    });
  });

  it('keeps what the user said and the AI asked where they happened', () => {
    const shown = runFromChain([
      run('r1', {
        entries: [
          { kind: 'message', at: 1, text: 'Leave db alone.' },
          {
            kind: 'command',
            at: 2,
            command: 'df -h',
            output: '',
            exitCode: 0,
            timedOut: false,
          },
          { kind: 'question', at: 3, text: 'Which site?' },
          { kind: 'answer', at: 4, text: 'shop.example.com' },
          { kind: 'stopped', at: 5, text: 'Stopped by user.' },
        ],
        status: 'stopped',
      }),
    ]);
    expect(shown.messages).toEqual([
      { text: 'Leave db alone.', at: 0 },
      { text: 'Which site?', at: 1, from: 'ai' },
      { text: 'shop.example.com', at: 1 },
    ]);
    expect(shown.steps[0]?.lines).toEqual([]);
    expect(shown.progress).toMatchObject({ phase: 'stopped', message: 'Stopped by user.' });
  });

  it('ends a run that failed on its last error, and puts earlier runs above the newest', () => {
    const shop = { stackId: 'stack-shop', name: 'shop' };
    const shown = runFromChain([
      run('r1', {
        prompt: 'First',
        app: shop,
        entries: [{ kind: 'finished', at: 1, text: 'one' }],
      }),
      run('r2', {
        prompt: 'Second',
        status: 'error',
        entries: [
          { kind: 'error', at: 1, text: 'The AI did not answer.' },
          { kind: 'continued', at: 2 },
          { kind: 'error', at: 3, text: 'It still did not.' },
        ],
      }),
    ]);
    expect(shown.earlier).toEqual([
      {
        prompt: 'First',
        steps: [],
        messages: [],
        progress: expect.objectContaining({ phase: 'finished', message: 'one' }),
      },
    ]);
    expect(shown.prompt).toBe('Second');
    expect(shown.progress).toMatchObject({ phase: 'error', message: 'It still did not.' });
    expect(shown.app).toEqual(shop);
  });

  it('shows a run that never ended as stopped', () => {
    const shown = runFromChain([run('r1', { status: 'running', endedAt: null, entries: [] })]);
    expect(shown.progress).toMatchObject({ phase: 'stopped' });
  });
});
