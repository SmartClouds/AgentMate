import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  journalInput,
  modeInput,
  registerDeployAssistantHandlers,
  startInput,
} from './deployAssistant';

/**
 * The Deploy AI's and the journal's channels answer only the main window and check every argument
 * before the service sees it.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const SUBSCRIPTION = '5b0e0f3c-8d6e-4c55-9d0e-3f7a1c2b9e10';

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const assistant = Object.fromEntries(
    ['start', 'approve', 'skip', 'answer', 'continue', 'stop', 'state', 'mode', 'setMode'].map(
      (name) => [name, vi.fn(async () => ({}))],
    ),
  ) as unknown as Record<string, ReturnType<typeof vi.fn>>;
  const journals = { watch: vi.fn(() => 'sub'), unwatch: vi.fn(() => true) };
  const owner = { id: 7, send: vi.fn() };
  registerDeployAssistantHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    assistant: assistant as never,
    journals,
    guard: () => trusted,
    owner: () => owner,
  });
  const call = (channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)?.({} as IpcMainInvokeEvent, ...args));
  return { assistant, journals, owner, call };
}

describe('deployAssistant channels', () => {
  it('refuses every window but the main one', async () => {
    const { call, assistant } = harness(false);
    await expect(call(IPC.deployAssistant.stop, 'srv-1')).rejects.toThrow(
      'Deploy is only available in the main window.',
    );
    expect(assistant.stop).not.toHaveBeenCalled();
  });

  it('passes checked calls through', async () => {
    const { call, assistant, journals, owner } = harness();
    await call(IPC.deployAssistant.start, {
      serverId: 'srv-1',
      prompt: 'Why is it down?',
      cliId: 'claude',
      modelId: 'opus',
      effort: 'high',
      context: { title: 'Crash loop', facts: ['restarting'], containerId: 'sender-1' },
    });
    expect(assistant.start).toHaveBeenCalledWith({
      serverId: 'srv-1',
      prompt: 'Why is it down?',
      cliId: 'claude',
      modelId: 'opus',
      effort: 'high',
      context: { title: 'Crash loop', facts: ['restarting'], containerId: 'sender-1' },
    });
    for (const [channel, method] of [
      [IPC.deployAssistant.approve, 'approve'],
      [IPC.deployAssistant.skip, 'skip'],
      [IPC.deployAssistant.resume, 'continue'],
      [IPC.deployAssistant.stop, 'stop'],
      [IPC.deployAssistant.state, 'state'],
      [IPC.deployAssistant.getMode, 'mode'],
    ] as const) {
      await call(channel, 'srv-1');
      expect(assistant[method]).toHaveBeenCalledWith('srv-1');
    }
    await call(IPC.deployAssistant.answer, 'srv-1', 'yes');
    expect(assistant.answer).toHaveBeenCalledWith('srv-1', 'yes');
    await call(IPC.deployAssistant.answer, 'srv-1', '');
    expect(assistant.answer).toHaveBeenLastCalledWith('srv-1', '');
    await call(IPC.deployAssistant.setMode, {
      serverId: 'srv-1',
      mode: 'autoRunDiagnostics',
      password: 'pw',
    });
    expect(assistant.setMode).toHaveBeenCalledWith({
      serverId: 'srv-1',
      mode: 'autoRunDiagnostics',
      password: 'pw',
    });
    await call(IPC.deployLogs.watchJournal, { serverId: 'srv-1', unit: 'nginx', follow: true });
    expect(journals.watch).toHaveBeenCalledWith(owner, {
      serverId: 'srv-1',
      unit: 'nginx',
      follow: true,
    });
    await call(IPC.deployLogs.unwatchJournal, SUBSCRIPTION);
    expect(journals.unwatch).toHaveBeenCalledWith(owner, SUBSCRIPTION);
    await expect(call(IPC.deployLogs.unwatchJournal, 'nope')).rejects.toThrow('not a subscription');
  });
});

describe('argument checks', () => {
  it('start: a task, ids that look like ids, and a bounded context', () => {
    expect(startInput({ serverId: 'srv-1', prompt: 'x' })).toEqual({
      serverId: 'srv-1',
      prompt: 'x',
      cliId: null,
      modelId: null,
      effort: null,
    });
    expect(startInput({ serverId: 'srv-1', prompt: 'x', continuePrevious: true })).toMatchObject({
      continuePrevious: true,
    });
    expect(
      startInput({ serverId: 'srv-1', prompt: 'x', continuePrevious: 'yes' }),
    ).not.toHaveProperty('continuePrevious');
    expect(() => startInput({ serverId: 'srv-1', prompt: '   ' })).toThrow('Describe what');
    expect(() => startInput({ serverId: 'srv-1', prompt: 'a'.repeat(4_001) })).toThrow();
    expect(() => startInput({ serverId: '../x', prompt: 'x' })).toThrow('saved server');
    expect(() => startInput({ serverId: 'srv-1', prompt: 'x', cliId: 'rm -rf' })).toThrow('CLI');
    expect(() => startInput({ serverId: 'srv-1', prompt: 'x', effort: 'huge' })).toThrow('effort');
    expect(() =>
      startInput({ serverId: 'srv-1', prompt: 'x', context: { title: 'a', facts: [1] } }),
    ).toThrow('Facts');
    expect(() =>
      startInput({
        serverId: 'srv-1',
        prompt: 'x',
        context: { title: 'a', facts: Array.from({ length: 21 }, () => 'f') },
      }),
    ).toThrow('Facts');
    expect(() =>
      startInput({ serverId: 'srv-1', prompt: 'x', context: { title: 'a', containerId: '-x' } }),
    ).toThrow('container');
    expect(() => startInput({ serverId: 'srv-1', prompt: 'x', context: 'nope' })).toThrow();
  });

  it('mode: one of the two, with an optional step-up', () => {
    expect(modeInput({ serverId: 'srv-1', mode: 'approveEveryCommand' })).toEqual({
      serverId: 'srv-1',
      mode: 'approveEveryCommand',
    });
    expect(() => modeInput({ serverId: 'srv-1', mode: 'autonomous' })).toThrow('Approve every');
  });

  it('journal: a unit name the core accepts and sane numbers', () => {
    expect(
      journalInput({
        serverId: 'srv-1',
        unit: 'docker.service',
        follow: false,
        lines: 10,
        sinceUnixMs: 5,
      }),
    ).toEqual({
      serverId: 'srv-1',
      unit: 'docker.service',
      follow: false,
      lines: 10,
      sinceUnixMs: 5,
    });
    for (const unit of ['-f', '../x', 'a b', '', 7]) {
      expect(() => journalInput({ serverId: 'srv-1', unit, follow: true })).toThrow('systemd unit');
    }
    expect(() => journalInput({ serverId: 'srv-1', unit: 'x', follow: 'yes' })).toThrow('follow');
    expect(() =>
      journalInput({ serverId: 'srv-1', unit: 'x', follow: true, lines: 5_000 }),
    ).toThrow('2000');
    expect(() =>
      journalInput({ serverId: 'srv-1', unit: 'x', follow: true, sinceUnixMs: -1 }),
    ).toThrow('time');
  });
});
