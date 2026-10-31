import type { SshAgentProgress } from '@shared/apiTypes';
import { beforeEach, describe, expect, it } from 'vitest';
import { GONE_MESSAGE, useDeployAssistantStore } from './deployAssistantStore';

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
const EMPTY = { progress: null, steps: [], messages: [] };

beforeEach(() => {
  useDeployAssistantStore.setState({
    openServerId: null,
    draft: null,
    runs: {},
    prompts: {},
    attachments: {},
    maximized: false,
    pageApp: null,
    dismissedApps: {},
    continueFrom: {},
  });
});

describe('deployAssistantStore', () => {
  it('opens and closes the drawer, keeping a draft for the same server', () => {
    const store = useDeployAssistantStore.getState();
    store.open(S, { prompt: 'Why?', context: { title: 'Crash loop' } });
    expect(useDeployAssistantStore.getState().draft).toEqual({
      serverId: S,
      context: { title: 'Crash loop' },
    });
    // The question goes in the box, where the user may change or send it.
    expect(useDeployAssistantStore.getState().prompts[S]).toBe('Why?');
    store.close();
    store.open(S);
    expect(useDeployAssistantStore.getState().draft?.context.title).toBe('Crash loop');
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
        messages: [],
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
    expect(run()).toEqual({ progress: null, steps: [], messages: [], earlier: [] });
    store.restore(S, undefined);
    expect(run()).toBeUndefined();
  });

  it('keeps the messages sent mid-run where they fell among the steps', () => {
    const store = useDeployAssistantStore.getState();
    const run = () => useDeployAssistantStore.getState().runs[S];
    store.said(S, 'Too early');
    expect(run()).toBeUndefined();

    store.reset(S, 'Free some disk');
    store.said(S, 'Leave the database alone');
    progress('running', 1, { command: 'df -h' });
    store.said(S, 'And the logs');
    expect(run()?.messages).toEqual([
      { text: 'Leave the database alone', at: 0 },
      { text: 'And the logs', at: 1 },
    ]);

    progress('stopped', 1);
    store.followUp(S, 'Carry on');
    expect(run()?.messages).toEqual([]);
    expect(run()?.earlier[0]?.messages).toHaveLength(2);
  });

  it('keeps the box per server, and a new question replaces only that one', () => {
    const store = useDeployAssistantStore.getState();
    store.setPrompt(S, 'Half typed');
    store.setPrompt('other', 'Elsewhere');
    // Opening without a draft, as the top bar button does, leaves the box alone.
    store.open(S);
    expect(useDeployAssistantStore.getState().prompts[S]).toBe('Half typed');
    store.open(S, { prompt: 'Read this log.', context: { title: 'Logs: api' } });
    expect(useDeployAssistantStore.getState().prompts).toEqual({
      [S]: 'Read this log.',
      other: 'Elsewhere',
    });
    // A sent prompt is cleared, and clearing the context does not bring it back.
    store.setPrompt(S, '');
    store.clearDraft();
    store.open(S);
    expect(useDeployAssistantStore.getState().prompts[S]).toBe('');
  });

  it('keeps the drawer maximized until the user restores it', () => {
    const store = useDeployAssistantStore.getState();
    store.setMaximized(true);
    store.close();
    store.open(S);
    expect(useDeployAssistantStore.getState().maximized).toBe(true);
    store.setMaximized(false);
    expect(useDeployAssistantStore.getState().maximized).toBe(false);
  });

  describe('the app the user has open', () => {
    const shop = { stackId: 'stack-shop', name: 'shop' };

    it('knows which app page is showing, until it is left', () => {
      const store = useDeployAssistantStore.getState();
      store.setPageApp({ serverId: S, ...shop });
      expect(useDeployAssistantStore.getState().pageApp).toEqual({ serverId: S, ...shop });
      store.setPageApp(null);
      expect(useDeployAssistantStore.getState().pageApp).toBeNull();
    });

    it('keeps a chat’s app through its follow-ups, and a new chat starts without one', () => {
      const store = useDeployAssistantStore.getState();
      store.reset(S, 'How is it?', shop);
      expect(useDeployAssistantStore.getState().runs[S]?.app).toEqual(shop);
      store.followUp(S, 'And now?');
      expect(useDeployAssistantStore.getState().runs[S]?.app).toEqual(shop);
      store.followUp(S, 'About the other one', { stackId: 'stack-blog', name: 'blog' });
      expect(useDeployAssistantStore.getState().runs[S]?.app?.name).toBe('blog');
      store.reset(S);
      expect(useDeployAssistantStore.getState().runs[S]?.app).toBeUndefined();
    });

    it('takes an app off a chat, or puts one on, without touching the rest', () => {
      const store = useDeployAssistantStore.getState();
      store.reset(S, 'How is it?', shop);
      store.setChatApp(S, null);
      expect(useDeployAssistantStore.getState().runs[S]?.app).toBeUndefined();
      expect(useDeployAssistantStore.getState().runs[S]?.prompt).toBe('How is it?');
      store.setChatApp(S, shop);
      expect(useDeployAssistantStore.getState().runs[S]?.app).toEqual(shop);
      store.setChatApp('srv-without-a-chat', shop);
      expect(useDeployAssistantStore.getState().runs['srv-without-a-chat']).toBeUndefined();
    });

    it('remembers an app the user took off, until they put it back', () => {
      const store = useDeployAssistantStore.getState();
      store.dismissApp(S, shop.stackId);
      expect(useDeployAssistantStore.getState().dismissedApps[S]).toBe(shop.stackId);
      store.dismissApp(S, null);
      expect(useDeployAssistantStore.getState().dismissedApps[S]).toBeUndefined();
    });
  });

  describe('a chat from the history', () => {
    it('shows it as it was and carries it on from its newest run', () => {
      const store = useDeployAssistantStore.getState();
      store.reset(S, 'Something else');
      store.openChat(
        S,
        {
          prompt: 'Why is shop slow?',
          steps: [],
          messages: [],
          earlier: [],
          progress: { sessionId: `deploy:${S}`, phase: 'finished', step: 1, message: 'Memory.' },
        },
        'run-7',
      );
      const state = useDeployAssistantStore.getState();
      expect(state.runs[S]?.prompt).toBe('Why is shop slow?');
      expect(state.continueFrom[S]).toBe('run-7');

      store.clearContinueFrom(S);
      expect(useDeployAssistantStore.getState().continueFrom[S]).toBeUndefined();
      store.openChat(S, { ...EMPTY, earlier: [] }, 'run-8');
      store.reset(S);
      expect(useDeployAssistantStore.getState().continueFrom[S]).toBeUndefined();
    });
  });

  describe('sync', () => {
    const run = () => useDeployAssistantStore.getState().runs[S];
    const state = (running: boolean, last: SshAgentProgress | null) => ({
      running,
      progress: last,
      context: null,
      history: [],
    });
    const at = (phase: SshAgentProgress['phase'], step: number, extra = {}) => ({
      sessionId: `deploy:${S}`,
      phase,
      step,
      ...extra,
    });

    it('picks up a run main has when there is none here', () => {
      useDeployAssistantStore.getState().sync(S, state(true, at('needs-input', 2)));
      expect(run()?.progress?.phase).toBe('needs-input');
    });

    it('leaves a run alone while main is still running it', () => {
      progress('running', 3, { command: 'uptime' });
      // An older word from main must not win over the events that came after it.
      useDeployAssistantStore.getState().sync(S, state(true, at('thinking', 2)));
      expect(run()?.progress?.phase).toBe('running');
      expect(steps().map((s) => s.status)).toEqual(['running']);
    });

    it('ends a run here that ended in main while nothing was listening', () => {
      progress('running', 3, { command: 'uptime' });
      useDeployAssistantStore
        .getState()
        .sync(S, state(false, at('finished', 3, { message: 'All good.' })));
      expect(run()?.progress?.phase).toBe('finished');
      expect(steps().map((s) => s.status)).toEqual(['done']);
    });

    it('ends a run main has no word on any more as stopped', () => {
      progress('proposed', 1, { command: 'df -h' });
      useDeployAssistantStore.getState().sync(S, state(false, null));
      expect(run()?.progress).toMatchObject({ phase: 'stopped', message: GONE_MESSAGE });
    });

    it('does not touch a run that is already over', () => {
      progress('stopped', 1, { message: 'Stopped by user.' });
      const before = run();
      useDeployAssistantStore.getState().sync(S, state(false, null));
      expect(run()).toBe(before);
    });
  });
});
