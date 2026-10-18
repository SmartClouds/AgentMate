import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TerminalAttachResult,
  TerminalPauseResult,
  TerminalRunStatusResult,
  TerminalUsageResult,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { withPlatform } from '../../test/main/fixtures';
import {
  expectChannelsCovered,
  fakeWebContents,
  invoke,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The terminal IPC as the renderer drives it. The pty host is the process boundary here, so it is
 * the only thing stubbed: `connectToHost` hands back a fake client that records what main asked
 * of it, and the in-process fallback manager stands in for node-pty (which is built for Electron's
 * ABI and will not load under plain node anyway).
 */

interface HostMessage {
  type: string;
  payload?: Record<string, unknown>;
}

const host = vi.hoisted(() => {
  const state = {
    /** False makes connectToHost resolve null, which is how terminals fall back in-process. */
    available: true,
    connectCalls: 0,
    requests: [] as HostMessage[],
    notifications: [] as HostMessage[],
    sessions: [] as { sessionId: string; pid: number; projectId?: string; createdAt: number }[],
    /** What the host answers a createOrAttach with. Throwing stands in for a host-side failure. */
    createOrAttach: (_payload: Record<string, unknown>): unknown => ({
      isNew: true,
      snapshot: null,
    }),
    events: null as null | {
      onData: (sessionId: string, data: string) => void;
      onExit: (sessionId: string, exitCode: number) => void;
      onDisconnect: () => void;
    },
  };

  // One stable client object, so a per-test change of behavior does not need a new backend.
  const client = {
    setEvents(events: NonNullable<typeof state.events>): void {
      state.events = events;
    },
    async request(message: HostMessage): Promise<unknown> {
      state.requests.push(message);
      if (message.type === 'list') return state.sessions;
      if (message.type === 'createOrAttach') {
        return state.createOrAttach(message.payload ?? {});
      }
      return undefined;
    },
    notify(message: HostMessage): void {
      state.notifications.push(message);
    },
    close(): void {
      return undefined;
    },
    async closeAfterFlush(): Promise<void> {
      return undefined;
    },
  };

  const local = {
    created: [] as Record<string, unknown>[],
    writes: [] as { sessionId: string; data: string }[],
    resizes: [] as { sessionId: string; cols: number; rows: number }[],
    killed: [] as string[],
  };

  return { state, client, local };
});

vi.mock('../ptyHost/hostLauncher', () => ({
  connectToHost: async () => {
    host.state.connectCalls += 1;
    if (!host.state.available) return null;
    return { client: host.client, hello: { protocolVersion: 1, appVersion: 'test', pid: 1 } };
  },
}));

vi.mock('../ptyHost/sessionManager', () => ({
  PtySessionManager: class {
    createOrAttach(payload: Record<string, unknown>): unknown {
      host.local.created.push(payload);
      return { isNew: true, snapshot: null };
    }
    write(sessionId: string, data: string): void {
      host.local.writes.push({ sessionId, data });
    }
    resize(sessionId: string, cols: number, rows: number): void {
      host.local.resizes.push({ sessionId, cols, rows });
    }
    kill(sessionId: string): void {
      host.local.killed.push(sessionId);
    }
    killAll(): void {
      return undefined;
    }
    list(): unknown[] {
      return [];
    }
  },
}));

// Reading the OS process table is its own process boundary, and a real reading would make the
// usage assertions depend on what else is running on the machine.
vi.mock('../system/processTree', () => ({
  sampleProcessTrees: async (pids: number[]) => ({
    available: true,
    cpuReady: true,
    trees: new Map(
      pids.map((pid) => [
        pid,
        // The shell and one child, whose pid is one higher.
        { cpuPercent: 12.5, memBytes: 1024, processCount: 2, processes: [], pids: [pid, pid + 1] },
      ]),
    ),
  }),
}));

// netstat (or lsof, or ss) is another process boundary. The child of shell 4242 serves 5173 and
// 9229; pid 7000 belongs to no terminal at all.
vi.mock('../system/listeningPorts', () => ({
  sampleListeningPorts: async () =>
    new Map([
      [4243, [5173, 9229]],
      [7000, [80]],
    ]),
}));

// Freezing processes is an OS boundary too. The fake freezes the shell and its child, like a run.
const suspend = vi.hoisted(() => ({
  suspended: [] as number[],
  resumed: [] as number[][],
  fails: false,
}));
vi.mock('../system/processSuspend', () => ({
  createProcessSuspender: () => ({
    suspendTree: async (pid: number) => {
      suspend.suspended.push(pid);
      if (suspend.fails) return { pids: [], names: [], failed: [{ pid, reason: 'access denied' }] };
      return { pids: [pid, pid + 1], names: ['bash', 'node'], failed: [] };
    },
    resumePids: async (pids: readonly number[]) => {
      suspend.resumed.push([...pids]);
      return { pids: [...pids].reverse(), names: [], failed: [] };
    },
    warm: async () => undefined,
  }),
}));

// The real list starts Python to ask for its Scripts folder.
const toolDirs = vi.hoisted(() => ({ current: [] as string[] }));
vi.mock('../toolPaths', () => ({ toolPathCandidates: () => toolDirs.current }));

const userData = useTempUserData();

// onData and onExit are pushed from main to the renderer, so nothing registers them as handlers.
// They are covered through the fake webContents instead, in "output and exit" below.
expectChannelsCovered(IPC.terminal, [
  IPC.terminal.onData,
  IPC.terminal.onExit,
  IPC.terminal.onPauseChange,
]);

/** The createOrAttach payload main sent to the host for the most recent create. */
function lastCreatePayload(): Record<string, unknown> {
  const request = [...host.state.requests].reverse().find((one) => one.type === 'createOrAttach');
  if (!request?.payload) throw new Error('no createOrAttach was sent to the host');
  return request.payload;
}

beforeEach(async () => {
  host.state.available = true;
  host.state.events = null;
  host.state.requests = [];
  host.state.notifications = [];
  host.state.sessions = [];
  host.state.createOrAttach = () => ({ isNew: true, snapshot: null });
  host.local.created = [];
  host.local.writes = [];
  host.local.resizes = [];
  host.local.killed = [];
  toolDirs.current = [];
  suspend.suspended = [];
  suspend.resumed = [];
  suspend.fails = false;
  terminal = await loadIpc(
    () => import('./terminal'),
    (module) => module.registerTerminalHandlers(),
  );
});

let terminal: typeof import('./terminal');

describe('terminal:create', () => {
  it('starts a session and passes the ids the hook scripts read back', async () => {
    const sender = fakeWebContents();
    const result = await invokeFrom<TerminalAttachResult>(sender, IPC.terminal.create, {
      sessionId: 'tab-1',
      cwd: 'C:\\projects\\demo',
      cols: 120,
      rows: 40,
      projectId: 'project-1',
      cliId: 'claude-code',
      surface: 'workspace',
    });
    expect(result).toEqual({ sessionId: 'tab-1', isNew: true, snapshot: null });

    const payload = lastCreatePayload();
    expect(payload).toMatchObject({
      sessionId: 'tab-1',
      cwd: 'C:\\projects\\demo',
      cols: 120,
      rows: 40,
      projectId: 'project-1',
    });
    expect(payload.env).toMatchObject({
      AGENTMATE_SESSION_ID: 'tab-1',
      AGENTMATE_PROJECT_ID: 'project-1',
    });
  });

  it('puts the tool folders on the end of PATH, even ones that do not exist yet', async () => {
    // Claude Code's native installer drops it in ~/.local/bin and adds that folder through a
    // shell rc file the app never reads, so without this `claude` would not run in the very tab
    // that just installed it.
    const key = Object.keys(process.env).find((one) => one.toUpperCase() === 'PATH') ?? 'PATH';
    vi.stubEnv(key, ['/usr/bin', '/already/here'].join(delimiter));
    toolDirs.current = ['/already/here', '/home/sam/.local/bin', '/not/created/yet'];

    await invoke(IPC.terminal.create, { sessionId: 'tool-path' });

    const env = lastCreatePayload().env as Record<string, string>;
    // Written back to the key already there, so the child does not end up with Path and PATH.
    expect(env[key]?.split(delimiter)).toEqual([
      '/usr/bin',
      '/already/here',
      '/home/sam/.local/bin',
      '/not/created/yet',
    ]);
  });

  it('only accepts a shell from the allowlist', async () => {
    await invoke(IPC.terminal.create, { sessionId: 'allowed', shell: 'bash' });
    expect(lastCreatePayload().shell).toBe('bash');

    // Anything else, including something a compromised renderer might try to smuggle in,
    // is replaced by the platform default rather than passed through.
    await withPlatform('win32', () =>
      invoke(IPC.terminal.create, { sessionId: 'smuggled', shell: 'cmd.exe /c calc.exe' }),
    );
    expect(lastCreatePayload().shell).toBe('powershell.exe');

    vi.stubEnv('SHELL', '/usr/bin/zsh');
    await withPlatform('linux', () =>
      invoke(IPC.terminal.create, { sessionId: 'posix', shell: '/bin/sh' }),
    );
    expect(lastCreatePayload().shell).toBe('zsh');
  });

  it('falls back to the platform shell when SHELL names something unstartable', async () => {
    // A Mac user who uninstalls the shell SHELL points at (or a Finder launch with a stripped
    // environment) used to hand that name to the pty as-is, which failed to start. Now the
    // platform default takes over instead of the terminal going blank.
    vi.stubEnv('SHELL', '/bin/sh');
    await withPlatform('linux', () => invoke(IPC.terminal.create, { sessionId: 'sh-linux' }));
    expect(lastCreatePayload().shell).toBe('bash');

    await withPlatform('darwin', () => invoke(IPC.terminal.create, { sessionId: 'sh-mac' }));
    expect(lastCreatePayload().shell).toBe('zsh');

    vi.stubEnv('SHELL', '');
    await withPlatform('darwin', () => invoke(IPC.terminal.create, { sessionId: 'empty-mac' }));
    expect(lastCreatePayload().shell).toBe('zsh');
  });

  it('replaces a session id that is not a plain identifier', async () => {
    const result = await invoke<TerminalAttachResult>(IPC.terminal.create, {
      sessionId: '../../etc/passwd',
    });
    expect(result.sessionId).not.toBe('../../etc/passwd');
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lastCreatePayload().sessionId).toBe(result.sessionId);
  });

  it('makes up an id when the renderer gives none', async () => {
    const result = await invoke<TerminalAttachResult>(IPC.terminal.create, {});
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns null when the session the tab wanted to reattach to has ended', async () => {
    host.state.createOrAttach = () => null;
    expect(
      await invoke<TerminalAttachResult | null>(IPC.terminal.create, {
        sessionId: 'gone',
        attachOnly: true,
      }),
    ).toBeNull();
  });

  it('leaves the previous window owning the session when a reattach fails', async () => {
    const first = fakeWebContents();
    await invokeFrom(first, IPC.terminal.create, { sessionId: 'owned' });

    const second = fakeWebContents();
    host.state.createOrAttach = () => {
      throw new Error('host went away');
    };
    await expect(invokeFrom(second, IPC.terminal.create, { sessionId: 'owned' })).rejects.toThrow(
      'host went away',
    );

    // Output still goes to the window that actually has the session on screen.
    host.state.events?.onData('owned', 'still mine');
    expect(first.sentOn(IPC.terminal.onData)).toEqual([
      [{ sessionId: 'owned', data: 'still mine' }],
    ]);
    expect(second.sentOn(IPC.terminal.onData)).toEqual([]);
  });
});

describe('terminal output and exit', () => {
  it('sends output to the window that created the session, and nowhere else', async () => {
    const owner = fakeWebContents();
    const bystander = fakeWebContents();
    await invokeFrom(owner, IPC.terminal.create, { sessionId: 'out-1' });
    await invokeFrom(bystander, IPC.terminal.create, { sessionId: 'out-2' });

    host.state.events?.onData('out-1', 'hello\r\n');
    expect(owner.sentOn(IPC.terminal.onData)).toEqual([
      [{ sessionId: 'out-1', data: 'hello\r\n' }],
    ]);
    expect(bystander.sentOn(IPC.terminal.onData)).toEqual([]);
  });

  it('follows the session when another window takes it over', async () => {
    const first = fakeWebContents();
    const second = fakeWebContents();
    await invokeFrom(first, IPC.terminal.create, { sessionId: 'moved' });
    await invokeFrom(second, IPC.terminal.create, { sessionId: 'moved' });

    host.state.events?.onData('moved', 'after the move');
    expect(first.sentOn(IPC.terminal.onData)).toEqual([]);
    expect(second.sentOn(IPC.terminal.onData)).toEqual([
      [{ sessionId: 'moved', data: 'after the move' }],
    ]);
  });

  it('tells the owner when the shell exits, and stops sending after that', async () => {
    const owner = fakeWebContents();
    await invokeFrom(owner, IPC.terminal.create, { sessionId: 'exiting' });

    host.state.events?.onExit('exiting', 3);
    expect(owner.sentOn(IPC.terminal.onExit)).toEqual([[{ sessionId: 'exiting', exitCode: 3 }]]);

    host.state.events?.onData('exiting', 'too late');
    expect(owner.sentOn(IPC.terminal.onData)).toEqual([]);
  });
});

describe('terminal:write, resize and kill', () => {
  it('forwards keystrokes to the host', async () => {
    await invoke(IPC.terminal.create, { sessionId: 'typing' });
    await invoke(IPC.terminal.write, 'typing', 'ls -la\r');
    expect(host.state.notifications).toContainEqual({
      type: 'write',
      payload: { sessionId: 'typing', data: 'ls -la\r' },
    });
  });

  it('forwards a resize', async () => {
    await invoke(IPC.terminal.create, { sessionId: 'sizing' });
    await invoke(IPC.terminal.resize, 'sizing', 100, 30);
    expect(host.state.notifications).toContainEqual({
      type: 'resize',
      payload: { sessionId: 'sizing', cols: 100, rows: 30 },
    });
  });

  it('kills the session and forgets the window that owned it', async () => {
    const owner = fakeWebContents();
    await invokeFrom(owner, IPC.terminal.create, { sessionId: 'doomed' });
    await invoke(IPC.terminal.kill, 'doomed');

    expect(host.state.notifications).toContainEqual({
      type: 'kill',
      payload: { sessionId: 'doomed' },
    });
    host.state.events?.onData('doomed', 'ignored');
    expect(owner.sentOn(IPC.terminal.onData)).toEqual([]);
  });

  it('passes a keystroke for a session that just ended on, without recreating it', async () => {
    // The renderer can race a kill against a keystroke, so this has to be harmless.
    await invoke(IPC.terminal.create, { sessionId: 'raced' });
    await invoke(IPC.terminal.kill, 'raced');
    await invoke(IPC.terminal.write, 'raced', 'x');
    expect(host.state.notifications).toContainEqual({
      type: 'write',
      payload: { sessionId: 'raced', data: 'x' },
    });
    expect(host.state.requests.filter((one) => one.type === 'createOrAttach')).toHaveLength(1);
  });
});

describe('terminal:usage', () => {
  it('joins what the host is running with what main knows about each tab', async () => {
    const sender = fakeWebContents();
    await invokeFrom(sender, IPC.terminal.create, {
      sessionId: 'usage-1',
      projectId: 'project-1',
      cliId: 'claude-code',
      surface: 'workspace',
    });
    host.state.sessions = [
      { sessionId: 'usage-1', pid: 4242, projectId: 'project-1', createdAt: 1000 },
      // A shell the host was already running before the app started: main knows nothing else.
      { sessionId: 'orphan', pid: 4343, projectId: 'project-2', createdAt: 900 },
    ];

    const usage = await invoke<TerminalUsageResult>(IPC.terminal.usage);
    expect(usage.available).toBe(true);
    expect(usage.cpuReady).toBe(true);
    expect(usage.sessions).toHaveLength(2);
    expect(usage.sessions[0]).toMatchObject({
      sessionId: 'usage-1',
      pid: 4242,
      projectId: 'project-1',
      cliId: 'claude-code',
      surface: 'workspace',
      cpuPercent: 12.5,
      memBytes: 1024,
      processCount: 2,
    });
    expect(usage.sessions[1]).toMatchObject({ sessionId: 'orphan', projectId: 'project-2' });
    expect(usage.sessions[1].cliId).toBeUndefined();
  });

  it('reports nothing before the first terminal, without starting the host for it', async () => {
    const usage = await invoke<TerminalUsageResult>(IPC.terminal.usage);
    expect(usage.sessions).toEqual([]);
    expect(host.state.requests).toEqual([]);
  });

  it('falls back to zeros for a session the host reports without a usable pid', async () => {
    await invoke(IPC.terminal.create, { sessionId: 'started' });
    host.state.sessions = [{ sessionId: 'no-pid', pid: 0, createdAt: 1 }];
    const usage = await invoke<TerminalUsageResult>(IPC.terminal.usage);
    expect(usage.sessions[0]).toMatchObject({ sessionId: 'no-pid', cpuPercent: 0, memBytes: 0 });
  });
});

describe('terminal:runStatus', () => {
  it('reports usage and the ports each run listens on, only for the runs asked about', async () => {
    await invoke(IPC.terminal.create, { sessionId: 'run-1' });
    host.state.sessions = [
      { sessionId: 'run-1', pid: 4242, createdAt: 1000 },
      { sessionId: 'agent-tab', pid: 6000, createdAt: 1000 },
    ];

    const result = await invoke<TerminalRunStatusResult>(IPC.terminal.runStatus, ['run-1']);

    expect(result.available).toBe(true);
    expect(result.cpuReady).toBe(true);
    // The port is held by the shell's child, not the shell, and still counts as the run's.
    expect(result.sessions).toEqual([
      {
        sessionId: 'run-1',
        alive: true,
        cpuPercent: 12.5,
        memBytes: 1024,
        processCount: 2,
        ports: [5173, 9229],
        paused: false,
        pauseReason: null,
        pausedAt: null,
      },
    ]);
  });

  it('says a run whose shell is gone is no longer alive', async () => {
    await invoke(IPC.terminal.create, { sessionId: 'started' });
    host.state.sessions = [];

    const result = await invoke<TerminalRunStatusResult>(IPC.terminal.runStatus, ['ended']);

    expect(result.sessions).toEqual([
      {
        sessionId: 'ended',
        alive: false,
        cpuPercent: 0,
        memBytes: 0,
        processCount: 0,
        ports: [],
        paused: false,
        pauseReason: null,
        pausedAt: null,
      },
    ]);
  });

  it('ignores ids that are not session ids, and asks nothing for an empty list', async () => {
    const empty = await invoke<TerminalRunStatusResult>(IPC.terminal.runStatus, []);
    expect(empty.sessions).toEqual([]);
    const junk = await invoke<TerminalRunStatusResult>(IPC.terminal.runStatus, ['../../etc', 42]);
    expect(junk.sessions).toEqual([]);
    const notAList = await invoke<TerminalRunStatusResult>(IPC.terminal.runStatus, 'run-1');
    expect(notAList.sessions).toEqual([]);
    expect(host.state.requests).toEqual([]);
  });
});

describe('pausing a run', () => {
  type FakeWindow = { webContents: { sentOn(channel: string): unknown[][] } };

  async function runningRun(sessionId = 'run-1', pid = 4242): Promise<void> {
    await invoke(IPC.terminal.create, { sessionId });
    host.state.sessions = [{ sessionId, pid, createdAt: 1000 }];
  }

  function pauseChanges(window: FakeWindow): unknown[] {
    return window.webContents.sentOn(IPC.terminal.onPauseChange).map(([change]) => change);
  }

  it("freezes the run's shell tree, tells every window and reports it as paused", async () => {
    const window = new BrowserWindow() as unknown as FakeWindow;
    await runningRun();

    const result = await invoke<TerminalPauseResult>(IPC.terminal.pause, 'run-1', 'user');

    expect(suspend.suspended).toEqual([4242]);
    expect(result).toMatchObject({ ok: true, paused: true, reason: 'user', processCount: 2 });
    expect(pauseChanges(window)).toEqual([
      expect.objectContaining({ sessionId: 'run-1', paused: true, reason: 'user' }),
    ]);
    const status = await invoke<TerminalRunStatusResult>(IPC.terminal.runStatus, ['run-1']);
    expect(status.sessions[0]).toMatchObject({ paused: true, pauseReason: 'user' });
    expect(status.sessions[0].pausedAt).toEqual(expect.any(Number));
  });

  it('thaws it again on resume', async () => {
    await runningRun();
    await invoke(IPC.terminal.pause, 'run-1', 'agent');

    const result = await invoke<TerminalPauseResult>(IPC.terminal.resume, 'run-1');

    expect(suspend.resumed).toEqual([[4242, 4243]]);
    expect(result).toMatchObject({ ok: true, paused: false });
    const status = await invoke<TerminalRunStatusResult>(IPC.terminal.runStatus, ['run-1']);
    expect(status.sessions[0].paused).toBe(false);
  });

  it('says why when nothing could be frozen', async () => {
    await runningRun();
    suspend.fails = true;

    const result = await invoke<TerminalPauseResult>(IPC.terminal.pause, 'run-1', 'user');

    expect(result).toMatchObject({ ok: false, paused: false, error: 'access denied' });
  });

  it('refuses a session that is not running, or a bad id or reason', async () => {
    await runningRun();

    expect(await invoke(IPC.terminal.pause, 'gone', 'user')).toMatchObject({
      ok: false,
      error: 'not running',
    });
    expect(await invoke(IPC.terminal.pause, '../etc', 'user')).toMatchObject({ ok: false });
    expect(await invoke(IPC.terminal.pause, 'run-1', 'root')).toMatchObject({ ok: false });
    expect(await invoke(IPC.terminal.resume, '../etc')).toMatchObject({ ok: false });
    expect(suspend.suspended).toEqual([]);
  });

  it('continues the frozen processes when a paused run is stopped on Linux', async () => {
    await withPlatform('linux', async () => {
      await runningRun();
      await invoke(IPC.terminal.pause, 'run-1', 'user');

      await invoke(IPC.terminal.kill, 'run-1');

      // The host's SIGHUP waits on a stopped process; SIGCONT lets it land.
      expect(host.state.notifications).toContainEqual({
        type: 'kill',
        payload: { sessionId: 'run-1' },
      });
      await vi.waitFor(() => expect(suspend.resumed).toEqual([[4242, 4243]]));
    });
  });

  it('just forgets a paused run stopped on Windows, where taskkill ends it frozen', async () => {
    await withPlatform('win32', async () => {
      await runningRun();
      await invoke(IPC.terminal.pause, 'run-1', 'user');

      await invoke(IPC.terminal.kill, 'run-1');

      expect(suspend.resumed).toEqual([]);
      const status = await invoke<TerminalRunStatusResult>(IPC.terminal.runStatus, ['run-1']);
      expect(status.sessions[0].paused).toBe(false);
    });
  });

  it('forgets a paused run whose shell ended', async () => {
    const window = new BrowserWindow() as unknown as FakeWindow;
    await runningRun();
    await invoke(IPC.terminal.pause, 'run-1', 'user');

    host.state.events?.onExit('run-1', 0);

    expect(pauseChanges(window).at(-1)).toMatchObject({ sessionId: 'run-1', paused: false });
  });

  it('keeps paused runs on disk and picks them up when main restarts', async () => {
    await runningRun();
    await invoke(IPC.terminal.pause, 'run-1', 'user');
    await terminal.flushRunPauses();
    const file = join(userData.dir, 'pty-host', 'paused-runs.json');
    expect(JSON.parse(readFileSync(file, 'utf-8')).runs).toHaveLength(1);

    // A fresh main connecting to the same host, which still runs the frozen shell.
    terminal = await loadIpc(
      () => import('./terminal'),
      (module) => module.registerTerminalHandlers(),
    );
    await invoke(IPC.terminal.create, { sessionId: 'other' });

    const status = await invoke<TerminalRunStatusResult>(IPC.terminal.runStatus, ['run-1']);
    expect(status.sessions[0]).toMatchObject({ paused: true, pauseReason: 'user' });
    await invoke(IPC.terminal.resume, 'run-1');
    expect(suspend.resumed).toEqual([[4242, 4243]]);
  });
});

describe('losing the host', () => {
  it('closes every open tab when the host connection drops', async () => {
    const owner = fakeWebContents();
    await invokeFrom(owner, IPC.terminal.create, { sessionId: 'dropped' });

    host.state.events?.onDisconnect();
    expect(owner.sentOn(IPC.terminal.onExit)).toEqual([[{ sessionId: 'dropped', exitCode: 1 }]]);
  });

  it('runs terminals in this process when the host cannot be started', async () => {
    // The backend is picked the first time a terminal is asked for, so this comes first.
    host.state.available = false;
    const owner = fakeWebContents();
    const result = await invokeFrom<TerminalAttachResult>(owner, IPC.terminal.create, {
      sessionId: 'in-process',
      shell: 'bash',
    });
    expect(result).toMatchObject({ sessionId: 'in-process', isNew: true });
    expect(host.local.created.at(-1)).toMatchObject({ sessionId: 'in-process', shell: 'bash' });

    await invoke(IPC.terminal.write, 'in-process', 'echo hi\r');
    await invoke(IPC.terminal.resize, 'in-process', 80, 24);
    await invoke(IPC.terminal.kill, 'in-process');
    expect(host.local.writes).toContainEqual({ sessionId: 'in-process', data: 'echo hi\r' });
    expect(host.local.resizes).toContainEqual({ sessionId: 'in-process', cols: 80, rows: 24 });
    expect(host.local.killed).toContain('in-process');
  });
});

describe('auto-continue', () => {
  /** What main typed into a session through the host, in order. */
  function writesTo(sessionId: string): string[] {
    return host.state.notifications
      .filter((one) => one.type === 'write' && one.payload?.sessionId === sessionId)
      .map((one) => String(one.payload?.data));
  }

  /** Opens an agent tab and turns auto-continue on for it, the way the workspace does. */
  async function agentTab(sessionId: string): Promise<void> {
    await invoke(IPC.terminal.create, { sessionId, cliId: 'claude-code' });
    terminal.autoContinue.sync([
      {
        sessionId,
        projectId: 'p1',
        cliId: 'claude-code',
        title: 'Claude Code',
        autoContinue: { afterLimitReset: true, afterNetworkError: true },
      },
    ]);
  }

  it('types continue into the shell once the usage limit has reset', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 19, 10, 0) });
    await agentTab('limited');
    host.state.events?.onData('limited', '5-hour limit reached ∙ resets 3pm (UTC)\r\n');
    expect(terminal.autoContinue.list().limited).toMatchObject({
      kind: 'limit',
      fireAt: Date.UTC(2026, 8, 19, 15, 1, 30),
    });

    await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
    expect(writesTo('limited')).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(writesTo('limited')).toEqual(['\x1b', 'continue', '\r']);
  });

  it('tells every window what is scheduled', async () => {
    const window = new BrowserWindow() as unknown as {
      webContents: { sentOn(channel: string): unknown[][] };
    };
    await agentTab('announced');
    host.state.events?.onData('announced', 'API Error: Connection error.');
    const [[changes]] = window.webContents.sentOn(IPC.agents.onAutoContinue) as [
      [Record<string, { kind: string }>],
    ];
    expect(changes.announced).toMatchObject({ kind: 'network' });
  });

  it('drops the scheduled continue when the user presses Enter in the tab', async () => {
    await agentTab('taken-over');
    host.state.events?.onData('taken-over', 'API Error: Connection error.');
    await invoke(IPC.terminal.write, 'taken-over', 'y');
    expect(terminal.autoContinue.list()['taken-over']).toBeTruthy();
    await invoke(IPC.terminal.write, 'taken-over', '\r');
    expect(terminal.autoContinue.list()['taken-over']).toBeUndefined();
  });

  it('ignores an old error the CLI repaints after a resize', async () => {
    await agentTab('resized');
    await invoke(IPC.terminal.resize, 'resized', 100, 30);
    host.state.events?.onData('resized', 'API Error: Connection error.');
    expect(terminal.autoContinue.list().resized).toBeUndefined();
  });

  it('forgets a tab when it is closed or its shell exits', async () => {
    await agentTab('closed');
    host.state.events?.onData('closed', 'API Error: Connection error.');
    await invoke(IPC.terminal.kill, 'closed');
    expect(terminal.autoContinue.list().closed).toBeUndefined();

    await agentTab('exited');
    host.state.events?.onData('exited', 'API Error: Connection error.');
    host.state.events?.onExit('exited', 0);
    expect(terminal.autoContinue.list().exited).toBeUndefined();
  });

  it('leaves a tab alone that did not turn it on', async () => {
    await invoke(IPC.terminal.create, { sessionId: 'plain', cliId: 'claude-code' });
    terminal.autoContinue.sync([
      { sessionId: 'plain', projectId: 'p1', cliId: 'claude-code', title: 'Claude Code' },
    ]);
    host.state.events?.onData('plain', 'API Error: Connection error.');
    expect(terminal.autoContinue.list()).toEqual({});
  });
});
