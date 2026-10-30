import { describe, expect, it } from 'vitest';
import type { SshAgentHistoryRun } from '../../../shared/apiTypes';
import { chainOf, chatsFrom } from './chats';

function run(id: string, extra: Partial<SshAgentHistoryRun> = {}): SshAgentHistoryRun {
  const at = Number(id.replace(/\D/g, '')) * 100;
  return {
    id,
    sessionId: 'deploy:srv-1',
    serverId: 'srv-1',
    scope: 'deploy',
    prompt: `prompt ${id}`,
    aiLabel: 'Claude Code',
    startedAt: at,
    endedAt: at + 50,
    status: 'finished',
    entries: [],
    ...extra,
  };
}

describe('chainOf', () => {
  it('walks back through the runs a run continued, oldest first', () => {
    const runs = [
      run('r1'),
      run('r2', { continuedFromRunId: 'r1' }),
      run('r3', { continuedFromRunId: 'r2' }),
    ];
    expect(chainOf(runs, 'r3').map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(chainOf(runs, 'r2').map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('stops at a run that is gone, and at a loop', () => {
    expect(chainOf([run('r2', { continuedFromRunId: 'gone' })], 'r2').map((r) => r.id)).toEqual([
      'r2',
    ]);
    const loop = [run('r1', { continuedFromRunId: 'r2' }), run('r2', { continuedFromRunId: 'r1' })];
    expect(chainOf(loop, 'r2').map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(chainOf([], 'r1')).toEqual([]);
  });
});

describe('chatsFrom', () => {
  it('folds follow-ups into their chat, named by its first question, newest chat first', () => {
    const runs = [
      run('r1', { prompt: 'Why is shop slow?' }),
      run('r2', { continuedFromRunId: 'r1', status: 'stopped' }),
      run('r3', { prompt: 'Check the disk', aiLabel: 'OpenAI' }),
    ];
    expect(chatsFrom(runs)).toEqual([
      {
        runId: 'r3',
        title: 'Check the disk',
        startedAt: 300,
        updatedAt: 350,
        status: 'finished',
        turns: 1,
        aiLabel: 'OpenAI',
      },
      {
        runId: 'r2',
        title: 'Why is shop slow?',
        startedAt: 100,
        updatedAt: 250,
        status: 'stopped',
        turns: 2,
        aiLabel: 'Claude Code',
      },
    ]);
  });

  it('names the app the chat was last about, and dates a running chat by its last entry', () => {
    const shop = { stackId: 's1', name: 'shop' };
    const [chat] = chatsFrom([
      run('r1', { app: shop }),
      run('r2', {
        continuedFromRunId: 'r1',
        status: 'running',
        endedAt: null,
        entries: [{ kind: 'message', at: 999, text: 'hi' }],
      }),
    ]);
    expect(chat).toMatchObject({ runId: 'r2', app: shop, status: 'running', updatedAt: 999 });
  });

  it('dates a chat that has only just started by its start', () => {
    const [chat] = chatsFrom([run('r4', { status: 'running', endedAt: null })]);
    expect(chat).toMatchObject({ runId: 'r4', status: 'running', updatedAt: 400 });
  });

  it('is empty without runs', () => {
    expect(chatsFrom([])).toEqual([]);
  });
});
