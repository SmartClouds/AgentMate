import type { SshSavedServer } from '@shared/apiTypes';
import { beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installRunovaBridge } from '../../../test/renderer/runovaBridge';
import {
  defaultNewSession,
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_MIN_HEIGHT,
  useTerminalStore,
} from './terminalStore';

let bridge: FakeBridge;

function store() {
  return useTerminalStore.getState();
}

function reset(): void {
  useTerminalStore.setState({
    isOpen: false,
    drawerHeight: TERMINAL_DEFAULT_HEIGHT,
    sessions: [],
    activeSessionId: null,
  });
}

const server = { id: 'srv-1', nickname: 'build box' } as SshSavedServer;

beforeEach(() => {
  bridge = installRunovaBridge({ platform: 'win32' });
  reset();
});

describe('defaultNewSession', () => {
  it('starts the shell that belongs to the platform, always called a terminal', () => {
    expect(defaultNewSession()).toEqual({ title: 'Terminal', shell: 'powershell.exe' });
    installRunovaBridge({ platform: 'darwin' });
    expect(defaultNewSession()).toEqual({ title: 'Terminal', shell: 'zsh' });
    installRunovaBridge({ platform: 'linux' });
    expect(defaultNewSession()).toEqual({ title: 'Terminal', shell: 'bash' });
  });
});

describe('the drawer', () => {
  it('starts closed at its default height', () => {
    expect(store().isOpen).toBe(false);
    expect(store().drawerHeight).toBe(TERMINAL_DEFAULT_HEIGHT);
  });

  it('opens, closes and toggles', () => {
    store().openDrawer();
    expect(store().isOpen).toBe(true);
    store().closeDrawer();
    expect(store().isOpen).toBe(false);
    store().toggleDrawer();
    expect(store().isOpen).toBe(true);
    store().toggleDrawer();
    expect(store().isOpen).toBe(false);
  });

  it('rounds a dragged height and never goes below the minimum', () => {
    store().setDrawerHeight(400.6);
    expect(store().drawerHeight).toBe(401);
    store().setDrawerHeight(10);
    expect(store().drawerHeight).toBe(TERMINAL_MIN_HEIGHT);
  });
});

describe('openSession', () => {
  it('adds a tab, makes it active and shows the drawer', () => {
    const id = store().openSession({ title: 'PowerShell', shell: 'powershell.exe' });
    expect(store().sessions).toHaveLength(1);
    expect(store().activeSessionId).toBe(id);
    expect(store().isOpen).toBe(true);
  });

  it('keeps everything the caller asked for', () => {
    store().openSession({
      title: 'Claude Code',
      cwd: 'E:\\proj',
      shell: 'powershell.exe',
      initialInput: 'claude\r',
      projectId: 'p1',
    });
    expect(store().sessions[0]).toMatchObject({
      title: 'Claude Code',
      cwd: 'E:\\proj',
      initialInput: 'claude\r',
      projectId: 'p1',
    });
  });

  it('keeps the server of a file manager tab', () => {
    store().openSession({ title: 'prod', kind: 'sftp', sftpServerId: 'srv-1' });
    expect(store().sessions[0]).toMatchObject({ kind: 'sftp', sftpServerId: 'srv-1' });
  });

  it('takes an id the caller chose, so a tab can be reopened as itself', () => {
    expect(store().openSession({ id: 'fixed', title: 'sh' })).toBe('fixed');
  });
});

describe('openDefaultSession', () => {
  it('names the first tab Terminal and numbers the ones after it', () => {
    store().openDefaultSession();
    store().openDefaultSession();
    store().openDefaultSession();
    expect(store().sessions.map((session) => session.title)).toEqual([
      'Terminal',
      'Terminal 2',
      'Terminal 3',
    ]);
  });

  it('counts only tabs running the same shell', () => {
    store().openSession({ title: 'bash', shell: 'bash' });
    store().openDefaultSession();
    expect(store().sessions.at(-1)?.title).toBe('Terminal');
  });
});

describe('openSshSession', () => {
  it('opens a tab named after the saved server', () => {
    store().openSshSession(server);
    expect(store().sessions[0]).toMatchObject({
      title: 'build box',
      kind: 'ssh',
      sshServerId: 'srv-1',
    });
  });

  it('takes a title, a command to type and the conversation it resumes', () => {
    const id = store().openSshSession(server, {
      title: 'build box · Fix the tests',
      initialInput: 'claude --resume abc-12345\r',
      conversationId: 'abc-12345',
    });
    expect(store().sessions[0]).toMatchObject({
      id,
      title: 'build box · Fix the tests',
      kind: 'ssh',
      sshServerId: 'srv-1',
      initialInput: 'claude --resume abc-12345\r',
      conversationId: 'abc-12345',
    });
    expect(store().activeSessionId).toBe(id);
    expect(store().isOpen).toBe(true);
  });
});

describe('findSshConversationTab', () => {
  it('finds the SSH tab already resuming a conversation on that server', () => {
    store().openSshSession(server);
    const id = store().openSshSession(server, { conversationId: 'abc-12345' });
    expect(store().findSshConversationTab('srv-1', 'abc-12345')).toBe(id);
  });

  it('ignores the same conversation on another server, and local tabs', () => {
    store().openSshSession(server, { conversationId: 'abc-12345' });
    store().openSession({ title: 'Claude Code', conversationId: 'zzz-12345' });
    expect(store().findSshConversationTab('srv-2', 'abc-12345')).toBeNull();
    expect(store().findSshConversationTab('srv-1', 'zzz-12345')).toBeNull();
    expect(store().findSshConversationTab('srv-1', 'missing')).toBeNull();
  });
});

describe('closeSession', () => {
  it('ends the shell and drops the tab', () => {
    const id = store().openDefaultSession();
    store().closeSession(id);
    // Ending the shell lives in the store, so a reload or a re-run of the effects never costs
    // the user a running shell.
    expect(bridge.$fn('terminal.kill')).toHaveBeenCalledWith(id);
    expect(store().sessions).toEqual([]);
    expect(store().activeSessionId).toBeNull();
  });

  it('ends an SSH tab through the SSH side', () => {
    const id = store().openSshSession(server);
    store().closeSession(id);
    expect(bridge.$fn('ssh.kill')).toHaveBeenCalledWith(id);
  });

  it('only drops a file manager tab: it has no shell, and its SFTP session stays open', () => {
    const id = store().openSession({ title: 'build box', kind: 'sftp', sftpServerId: 'srv-1' });
    store().closeSession(id);
    expect(store().sessions).toEqual([]);
    // Neither side was asked to end anything ($fn throws for a function nobody touched).
    expect(() => bridge.$fn('terminal.kill')).toThrow();
    expect(() => bridge.$fn('ssh.kill')).toThrow();
  });

  it('moves to the last remaining tab', () => {
    const first = store().openDefaultSession();
    const second = store().openDefaultSession();
    const third = store().openDefaultSession();
    store().setActiveSession(second);
    store().closeSession(second);
    expect(store().activeSessionId).toBe(third);
    store().closeSession(third);
    expect(store().activeSessionId).toBe(first);
  });

  it('leaves the active tab alone when another one closes', () => {
    const first = store().openDefaultSession();
    const second = store().openDefaultSession();
    store().closeSession(first);
    expect(store().activeSessionId).toBe(second);
  });
});

describe('forgetSession', () => {
  it('drops a tab whose shell has already ended, without killing anything', () => {
    const id = store().openDefaultSession();
    store().forgetSession(id);
    expect(store().sessions).toEqual([]);
    expect(() => bridge.$fn('terminal.kill')).toThrow();
  });
});

describe('setActiveSession', () => {
  it('switches the tab on screen', () => {
    const first = store().openDefaultSession();
    store().openDefaultSession();
    store().setActiveSession(first);
    expect(store().activeSessionId).toBe(first);
  });
});

describe('moveSession', () => {
  function openThree(): string[] {
    return [
      store().openSession({ id: 'a', title: 'A' }),
      store().openSession({ id: 'b', title: 'B' }),
      store().openSession({ id: 'c', title: 'C' }),
    ];
  }

  function order(): string[] {
    return store().sessions.map((session) => session.id);
  }

  it('moves a tab right, so it lands where the drop put it', () => {
    openThree();
    store().moveSession(0, 2);
    expect(order()).toEqual(['b', 'c', 'a']);
  });

  it('moves a tab left', () => {
    openThree();
    store().moveSession(2, 0);
    expect(order()).toEqual(['c', 'a', 'b']);
  });

  it('keeps the active tab active, wherever it ends up', () => {
    openThree();
    store().setActiveSession('a');
    store().moveSession(0, 2);
    expect(store().activeSessionId).toBe('a');
  });

  it('changes nothing for a move to the same place or off the ends', () => {
    openThree();
    const before = store().sessions;
    store().moveSession(1, 1);
    store().moveSession(-1, 1);
    store().moveSession(1, 3);
    store().moveSession(5, 0);
    expect(store().sessions).toBe(before);
  });

  it('saves the new order for the next start', () => {
    openThree();
    store().moveSession(2, 0);
    const saved = JSON.parse(localStorage.getItem('runova-terminal-sessions') ?? '{}');
    expect(saved.state.sessions.map((session: { id: string }) => session.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});

describe('coming back from a saved drawer', () => {
  function seed(state: Record<string, unknown>): void {
    localStorage.setItem('runova-terminal-sessions', JSON.stringify({ state, version: 0 }));
  }

  async function rehydrate(): Promise<void> {
    await useTerminalStore.persist.rehydrate();
  }

  it('marks every restored tab, so it reconnects instead of starting a shell', async () => {
    seed({
      isOpen: true,
      drawerHeight: 350,
      activeSessionId: 's2',
      sessions: [
        { id: 's1', title: 'PowerShell' },
        { id: 's2', title: 'bash' },
      ],
    });
    await rehydrate();
    expect(store().sessions.every((session) => session.restored)).toBe(true);
    expect(store().drawerHeight).toBe(350);
    expect(store().activeSessionId).toBe('s2');
    expect(store().isOpen).toBe(true);
  });

  it('keeps the drawer shut when nothing came back with it', async () => {
    seed({ isOpen: true, sessions: [] });
    await rehydrate();
    expect(store().isOpen).toBe(false);
  });

  it('falls back to the last tab when the saved active one is gone', async () => {
    seed({ isOpen: true, activeSessionId: 'missing', sessions: [{ id: 's1', title: 'sh' }] });
    await rehydrate();
    expect(store().activeSessionId).toBe('s1');
  });

  it('survives a saved blob with no sessions array in it', async () => {
    seed({ isOpen: true, sessions: 'not an array' });
    await rehydrate();
    expect(store().sessions).toEqual([]);
    expect(store().activeSessionId).toBeNull();
    expect(store().drawerHeight).toBe(TERMINAL_DEFAULT_HEIGHT);
  });

  it('never saves the command a tab already ran', () => {
    store().openSession({ title: 'Claude Code', initialInput: 'claude\r' });
    const saved = JSON.parse(localStorage.getItem('runova-terminal-sessions') ?? '{}');
    // A reconnect must never type it a second time.
    expect(saved.state.sessions[0].initialInput).toBeUndefined();
  });

  it('keeps a run tab a run across a restart, without its command to type', async () => {
    const run = {
      commandId: 'dev',
      label: 'Dev',
      command: 'pnpm dev',
      kind: 'web' as const,
      startedAt: 1_700_000_000_000,
    };
    store().openSession({ title: 'Apollo', initialInput: 'pnpm dev\r', run });
    const raw = localStorage.getItem('runova-terminal-sessions') ?? '{}';
    const saved = JSON.parse(raw);
    expect(saved.state.sessions[0].run).toEqual(run);
    expect(saved.state.sessions[0].initialInput).toBeUndefined();

    // Clearing the store writes an empty drawer, so the saved one goes back before reading it.
    reset();
    localStorage.setItem('runova-terminal-sessions', raw);
    await useTerminalStore.persist.rehydrate();
    // Still listed in the status bar after a restart, with the time it really started.
    expect(store().sessions[0]).toMatchObject({ run, restored: true });
  });

  it('never saves an SSH tab, which has no host to reattach to', () => {
    store().openSshSession(server);
    store().openDefaultSession();
    const saved = JSON.parse(localStorage.getItem('runova-terminal-sessions') ?? '{}');
    expect(saved.state.sessions).toHaveLength(1);
    expect(saved.state.sessions[0].kind).toBeUndefined();
  });

  it('never saves a file manager tab, which a restart would only reopen disconnected', () => {
    store().openSession({ title: 'build box', kind: 'sftp', sftpServerId: 'srv-1' });
    store().openDefaultSession();
    const saved = JSON.parse(localStorage.getItem('runova-terminal-sessions') ?? '{}');
    expect(saved.state.sessions).toHaveLength(1);
    expect(saved.state.sessions[0].kind).toBeUndefined();
  });

  it('drops a file manager tab found in an older save', async () => {
    seed({
      isOpen: true,
      sessions: [
        { id: 'f1', title: 'build box', kind: 'sftp', sftpServerId: 'srv-1' },
        { id: 't1', title: 'Terminal', shell: 'powershell.exe' },
      ],
      activeSessionId: 'f1',
    });
    await rehydrate();
    expect(store().sessions.map((s) => s.id)).toEqual(['t1']);
    expect(store().activeSessionId).toBe('t1');
  });

  it('never saves a resumed SSH tab or the command it typed', () => {
    store().openSshSession(server, {
      initialInput: 'claude --resume abc-12345\r',
      conversationId: 'abc-12345',
    });
    const raw = localStorage.getItem('runova-terminal-sessions') ?? '{}';
    expect(JSON.parse(raw).state.sessions).toEqual([]);
    expect(raw).not.toContain('--resume');
  });
});
