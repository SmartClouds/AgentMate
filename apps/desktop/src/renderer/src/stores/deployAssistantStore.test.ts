import type { SshAgentProgress } from '@shared/apiTypes';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDeployAssistantStore } from './deployAssistantStore';

/** The drawer's timeline as progress events and output arrive, for one server. */

const S = 'srv-1';

function progress(
  phase: SshAgentProgress['phase'],
  step: number,
  extra: Partial<SshAgentProgress> = {},
) {
  useDeployAssistantStore
    .getState()
    .progress({ serverId: S, progress: { sessionId: `deploy:${S}`, phase, step, ...extra } });
}

const steps = () => useDeployAssistantStore.getState().runs[S]?.steps ?? [];

beforeEach(() => {
  useDeployAssistantStore.setState({ openServerId: null, draft: null, runs: {} });
});

describe('deployAssistantStore', () => {
  it('opens and closes the drawer, keeping a draft for the same server', () => {
    const store = useDeployAssistantStore.getState();
    store.open(S, { prompt: 'Why?', context: { title: 'Crash loop' } });
    expect(useDeployAssistantStore.getState().draft).toEqual({
      serverId: S,
      prompt: 'Why?',
      context: { title: 'Crash loop' },
    });
    store.close();
    store.open(S);
    expect(useDeployAssistantStore.getState().draft?.prompt).toBe('Why?');
    store.open('other');
    expect(useDeployAssistantStore.getState().draft).toBeNull();
    expect(useDeployAssistantStore.getState().openServerId).toBe('other');
    store.open(S, { prompt: 'x', context: { title: 't' } });
    store.clearDraft();
    expect(useDeployAssistantStore.getState().draft).toBeNull();
  });

  it('builds steps from proposals, runs and their ends', () => {
    progress('thinking', 1);
    expect(steps()).toEqual([]);
    progress('proposed', 1, { command: 'df -h' });
    progress('thinking', 2);
    expect(steps().map((s) => s.status)).toEqual(['skipped']);

    progress('running', 2, { command: 'uptime' });
    useDeployAssistantStore.getState().output({
      serverId: S,
      command: 'uptime',
      lines: [{ stream: 'out', text: 'up 3 days' }],
    });
    // Output for another command or server is not this step's.
    useDeployAssistantStore.getState().output({ serverId: S, command: 'other', lines: [] });
    useDeployAssistantStore.getState().output({ serverId: 'nope', command: 'uptime', lines: [] });
    progress('thinking', 3);
    expect(steps()[1]).toMatchObject({ status: 'done', lines: [{ text: 'up 3 days' }] });

    // A command the core sent back for approval stays one step.
    progress('running', 3, { command: 'rm -rf /' });
    progress('proposed', 3, { command: 'rm -rf /', message: 'Approve it' });
    expect(steps()).toHaveLength(3);
    expect(steps()[2]).toMatchObject({ status: 'proposed', note: 'Approve it' });
    progress('running', 3, { command: 'rm -rf /' });
    progress('finished', 3, { message: 'done' });
    expect(steps()[2]?.status).toBe('done');
    progress('stopped', 3);
    expect(useDeployAssistantStore.getState().runs[S]?.progress?.phase).toBe('stopped');

    useDeployAssistantStore.getState().reset(S);
    expect(steps()).toEqual([]);
  });

  it('carries a chat on with follow-ups and starts over with a new chat', () => {
    const store = useDeployAssistantStore.getState();
    const run = () => useDeployAssistantStore.getState().runs[S];
    store.reset(S, 'Why does it restart?');
    progress('running', 1, { command: 'docker ps' });
    progress('stopped', 1, { message: 'Stopped by user.' });

    store.followUp(S, 'Carry on');
    expect(run()).toMatchObject({ prompt: 'Carry on', steps: [], progress: null });
    expect(run()?.earlier).toEqual([
      {
        prompt: 'Why does it restart?',
        progress: expect.objectContaining({ phase: 'stopped' }),
        steps: [expect.objectContaining({ command: 'docker ps', status: 'done' })],
      },
    ]);
    progress('thinking', 1);
    expect(run()?.earlier).toHaveLength(1);

    const before = run();
    store.followUp(S, 'And the disk?');
    expect(run()?.earlier).toHaveLength(2);
    store.restore(S, before);
    expect(run()).toBe(before);

    store.reset(S);
    expect(run()).toEqual({ progress: null, steps: [], earlier: [] });
    store.restore(S, undefined);
    expect(run()).toBeUndefined();
  });
});
