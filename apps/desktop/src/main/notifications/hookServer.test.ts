import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LocalServer, startHttpServer } from '../../test/main/fixtures';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * The hook server is the one port Runova opens to the machine it runs on, so the cases that
 * matter are the ones about trust: the secret it writes next to the port, what happens without
 * it, and which payloads are allowed to move a tab's status or fire a Telegram message.
 *
 * The terminal and status modules are stubbed because importing them boots the pty host, which
 * is a different subsystem with its own tests. Everything else, including the Telegram client and
 * the server itself, is real.
 */

const writes: { sessionId: string; data: string }[] = [];
const sessionsByProject = new Map<string, string>();

vi.mock('../ipc/terminal', () => ({
  SESSION_ID_PATTERN: /^[A-Za-z0-9_-]{1,128}$/,
  findSessionIdForProject: (projectId: string) => sessionsByProject.get(projectId) ?? null,
  writeToSession: (sessionId: string, data: string) => {
    writes.push({ sessionId, data });
  },
}));

const hookCalls: { id: string; event: string; message?: string }[] = [];
const runInfoCalls: { id: string; info: Record<string, unknown> }[] = [];

vi.mock('../agents/statusTracker', () => ({
  agentStatus: {
    hook: (id: string, event: string, message?: string) => {
      hookCalls.push({ id, event, message });
      return true;
    },
    runInfo: async (id: string, info: Record<string, unknown>) => {
      runInfoCalls.push({ id, info });
    },
  },
}));

const petMessages: { projectName: string; text: string }[] = [];

vi.mock('./petNotifier', () => ({
  speakOnPet: (_settings: unknown, projectName: string, text: string) => {
    petMessages.push({ projectName, text });
    return true;
  },
}));

const userData = useTempUserData();

let telegram: LocalServer | null = null;
let stopServer: (() => void) | null = null;

interface PortFile {
  port: number;
  token: string;
}

/** Points the Telegram client at a local server without stubbing fetch itself away. */
function redirectTelegramToLocal(target: string): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.hostname !== 'api.telegram.org') return realFetch(input, init);
    return realFetch(`${target}${url.pathname}${url.search}`, init);
  });
}

function seedProject(overrides: Record<string, unknown> = {}): void {
  userData.writeData('projects.json', [
    {
      id: 'p1',
      name: 'Checkout',
      path: 'C:/code/checkout',
      notifications: {
        completion: { enabled: true, message: '{{project}} is done' },
        confirmation: { enabled: true, message: '{{project}} needs a yes' },
        pet: { enabled: true, message: '{{project}} says hi' },
      },
      ...overrides,
    },
  ]);
}

async function startAndRead(): Promise<PortFile> {
  const module = await import('./hookServer');
  await module.startHookServer();
  stopServer = module.stopHookServer;
  return JSON.parse(readFileSync(module.portFilePath(), 'utf-8')) as PortFile;
}

/** Only the Telegram sends, leaving out the startup baseline getUpdates poll. */
function sendMessages(local: LocalServer): { body: string }[] {
  return local.requests.filter((one) => one.url.includes('sendMessage'));
}

/** Posts to the running hook server and waits for its 204 before asserting. */
async function post(port: number, path: string, body: unknown): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return response.status;
}

beforeEach(() => {
  writes.length = 0;
  hookCalls.length = 0;
  runInfoCalls.length = 0;
  petMessages.length = 0;
  sessionsByProject.clear();
});

afterEach(async () => {
  stopServer?.();
  stopServer = null;
  await telegram?.close();
  telegram = null;
});

describe('startHookServer', () => {
  it('writes the port and a secret into the app data folder', async () => {
    const file = await startAndRead();

    expect(file.port).toBeGreaterThan(0);
    // The secret is what separates Runova's own generated scripts from any other local
    // process that can reach the port.
    expect(file.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('is idempotent, so a second call keeps the same port', async () => {
    const first = await startAndRead();
    const module = await import('./hookServer');
    await module.startHookServer();

    const second = JSON.parse(readFileSync(module.portFilePath(), 'utf-8')) as PortFile;
    expect(second.port).toBe(first.port);
  });

  it('answers anything that is not a hook POST with 404', async () => {
    const file = await startAndRead();

    const get = await fetch(`http://127.0.0.1:${file.port}/hook`);
    const unknownPath = await post(file.port, '/whatever', {});

    expect(get.status).toBe(404);
    expect(unknownPath).toBe(404);
  });

  it('refuses a body far larger than a hook payload', async () => {
    const file = await startAndRead();

    const response = await fetch(`http://127.0.0.1:${file.port}/agent-event`, {
      method: 'POST',
      body: 'x'.repeat(200_000),
    }).catch(() => null);

    // Either the 413 lands or the socket is cut; what matters is nothing was processed.
    expect(response === null || response.status === 413).toBe(true);
    expect(hookCalls).toEqual([]);
  });
});

describe('/agent-event', () => {
  it('ignores an event with no secret', async () => {
    const file = await startAndRead();

    expect(await post(file.port, '/agent-event', { sessionId: 's1', event: 'Stop' })).toBe(204);

    // Answering 204 regardless keeps the hook script quiet, but nothing may be recorded.
    expect(hookCalls).toEqual([]);
    expect(runInfoCalls).toEqual([]);
  });

  it('ignores an event with the wrong secret', async () => {
    const file = await startAndRead();

    await post(file.port, '/agent-event', {
      token: 'f'.repeat(48),
      sessionId: 's1',
      event: 'Stop',
    });

    expect(hookCalls).toEqual([]);
  });

  it('accepts an event carrying the secret and records the run info', async () => {
    const file = await startAndRead();

    await post(file.port, '/agent-event', {
      token: file.token,
      sessionId: 'tab-1',
      event: 'UserPromptSubmit',
      model: 'claude-opus-5',
      effort: 'high',
      transcriptPath: '/tmp/t.jsonl',
    });

    await vi.waitFor(() => expect(hookCalls).toHaveLength(1));
    expect(hookCalls[0]).toMatchObject({ id: 'tab-1', event: 'prompt' });
    expect(runInfoCalls[0]).toEqual({
      id: 'tab-1',
      info: { model: 'claude-opus-5', effort: 'high', transcriptPath: '/tmp/t.jsonl' },
    });
  });

  it('refuses a session id that is not in the expected shape', async () => {
    const file = await startAndRead();

    await post(file.port, '/agent-event', {
      token: file.token,
      sessionId: '../../etc/passwd',
      event: 'Stop',
    });

    expect(hookCalls).toEqual([]);
    expect(runInfoCalls).toEqual([]);
  });

  it.each([
    ['Stop', 'stop'],
    ['SessionEnd', 'session-end'],
    ['UserPromptSubmit', 'prompt'],
  ])('maps the %s hook to %s', async (event, expected) => {
    const file = await startAndRead();

    await post(file.port, '/agent-event', { token: file.token, sessionId: 's1', event });

    await vi.waitFor(() => expect(hookCalls).toHaveLength(1));
    expect(hookCalls[0].event).toBe(expected);
  });

  it.each([
    'permission_prompt',
    'elicitation_dialog',
    'elicitation_url_dialog',
    'agent_needs_input',
  ])('treats the %s notification as needing input', async (notificationType) => {
    const file = await startAndRead();

    await post(file.port, '/agent-event', {
      token: file.token,
      sessionId: 's1',
      event: 'Notification',
      notificationType,
      message: 'Claude needs your permission to run rm',
    });

    await vi.waitFor(() => expect(hookCalls).toHaveLength(1));
    expect(hookCalls[0].event).toBe('needs-input');
    expect(hookCalls[0].message).toBe('Claude needs your permission to run rm');
  });

  it('ignores the idle reminder, which is not a new question', async () => {
    const file = await startAndRead();

    await post(file.port, '/agent-event', {
      token: file.token,
      sessionId: 's1',
      event: 'Notification',
      notificationType: 'idle_prompt',
      message: 'Claude is waiting for your input',
    });

    await vi.waitFor(() => expect(runInfoCalls).toHaveLength(1));
    // The run info still lands, but the tab must not start flashing again.
    expect(hookCalls).toEqual([]);
  });

  it('falls back to reading the message when the type is unfamiliar', async () => {
    const file = await startAndRead();

    await post(file.port, '/agent-event', {
      token: file.token,
      sessionId: 's1',
      event: 'Notification',
      notificationType: 'something_new',
      message: 'Codex needs your approval',
    });
    await post(file.port, '/agent-event', {
      token: file.token,
      sessionId: 's2',
      event: 'Notification',
      notificationType: 'something_new',
      message: 'Compacting conversation history',
    });

    await vi.waitFor(() => expect(runInfoCalls).toHaveLength(2));
    expect(hookCalls).toEqual([
      { id: 's1', event: 'needs-input', message: 'Codex needs your approval' },
    ]);
  });

  it('truncates an oversized model name and message', async () => {
    const file = await startAndRead();

    await post(file.port, '/agent-event', {
      token: file.token,
      sessionId: 's1',
      event: 'Notification',
      notificationType: 'permission_prompt',
      message: 'm'.repeat(500),
      model: 'x'.repeat(500),
      effort: 'e'.repeat(80),
    });

    await vi.waitFor(() => expect(hookCalls).toHaveLength(1));
    // A hostile or buggy script must not be able to push an unbounded string into the UI.
    expect(hookCalls[0].message).toHaveLength(200);
    expect(runInfoCalls[0].info.model).toHaveLength(100);
    expect(runInfoCalls[0].info.effort).toHaveLength(20);
  });

  it('survives a body that is not JSON', async () => {
    const file = await startAndRead();

    expect(await post(file.port, '/agent-event', 'not json at all')).toBe(204);
    expect(hookCalls).toEqual([]);
  });
});

describe('/hook', () => {
  it('speaks a pet hook through the companion with the project name filled in', async () => {
    userData.writeData('settings.json', { desktopPetEnabled: true });
    seedProject();
    const file = await startAndRead();

    await post(file.port, '/hook', { projectId: 'p1', kind: 'pet' });

    await vi.waitFor(() => expect(petMessages).toHaveLength(1));
    expect(petMessages[0]).toEqual({ projectName: 'Checkout', text: 'Checkout says hi' });
  });

  it('sends a completion hook to Telegram', async () => {
    telegram = await startHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
    redirectTelegramToLocal(telegram.url);
    userData.writeData('settings.json', { telegramBotToken: 'tok', telegramChatId: '-100' });
    seedProject();
    const file = await startAndRead();

    await post(file.port, '/hook', { projectId: 'p1', kind: 'completion' });

    await vi.waitFor(() => expect(sendMessages(telegram as LocalServer)).toHaveLength(1));
    expect(JSON.parse(sendMessages(telegram)[0].body)).toEqual({
      chat_id: '-100',
      text: 'Checkout is done',
    });
  });

  it('stays quiet when the hook is switched off for the project', async () => {
    telegram = await startHttpServer((_request, response) => {
      response.end('{}');
    });
    redirectTelegramToLocal(telegram.url);
    userData.writeData('settings.json', { telegramBotToken: 'tok', telegramChatId: '-100' });
    seedProject({
      notifications: {
        completion: { enabled: false, message: 'nope' },
        confirmation: { enabled: false, message: 'nope' },
        pet: { enabled: false, message: 'nope' },
      },
    });
    const file = await startAndRead();

    await post(file.port, '/hook', { projectId: 'p1', kind: 'completion' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sendMessages(telegram)).toEqual([]);
    expect(petMessages).toEqual([]);
  });

  it('ignores a project id that does not exist', async () => {
    telegram = await startHttpServer((_request, response) => {
      response.end('{}');
    });
    redirectTelegramToLocal(telegram.url);
    userData.writeData('settings.json', { telegramBotToken: 'tok', telegramChatId: '-100' });
    seedProject();
    const file = await startAndRead();

    await post(file.port, '/hook', { projectId: 'gone', kind: 'completion' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sendMessages(telegram)).toEqual([]);
  });

  it('ignores a kind that is not one of the known hooks', async () => {
    telegram = await startHttpServer((_request, response) => {
      response.end('{}');
    });
    redirectTelegramToLocal(telegram.url);
    userData.writeData('settings.json', { telegramBotToken: 'tok', telegramChatId: '-100' });
    seedProject();
    const file = await startAndRead();

    await post(file.port, '/hook', { projectId: 'p1', kind: 'rm -rf' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sendMessages(telegram)).toEqual([]);
  });

  it('does nothing for a Telegram hook when the bot is not configured', async () => {
    telegram = await startHttpServer((_request, response) => {
      response.end('{}');
    });
    redirectTelegramToLocal(telegram.url);
    userData.writeData('settings.json', {});
    seedProject();
    const file = await startAndRead();

    await post(file.port, '/hook', { projectId: 'p1', kind: 'completion' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sendMessages(telegram)).toEqual([]);
  });

  it('survives a malformed hook body', async () => {
    const file = await startAndRead();

    expect(await post(file.port, '/hook', '{ broken')).toBe(204);
  });
});

describe('confirmation round trip', () => {
  it('writes a Telegram reply back into the project terminal and tells the renderer', async () => {
    let updateCalls = 0;
    telegram = await startHttpServer((request, response) => {
      const url = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      if (url.includes('sendMessage')) {
        response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        return;
      }
      updateCalls += 1;
      // The first getUpdates is the startup baseline, so the reply arrives on a later poll.
      if (updateCalls <= 1) {
        response.end(JSON.stringify({ ok: true, result: [] }));
        return;
      }
      response.end(
        JSON.stringify({
          ok: true,
          result: [{ update_id: 7, message: { chat: { id: -100 }, text: 'yes please' } }],
        }),
      );
    });
    redirectTelegramToLocal(telegram.url);
    userData.writeData('settings.json', { telegramBotToken: 'tok', telegramChatId: '-100' });
    seedProject();
    sessionsByProject.set('p1', 'tab-9');

    const { FakeBrowserWindow, electronState } = await import('../../test/main/electronMock');
    const window = new FakeBrowserWindow();
    const file = await startAndRead();

    await post(file.port, '/hook', { projectId: 'p1', kind: 'confirmation' });

    await vi.waitFor(() => expect(writes).toHaveLength(1), { timeout: 10_000 });
    // The reply has to reach the agent as if the user had typed it, carriage return included.
    expect(writes[0]).toEqual({ sessionId: 'tab-9', data: 'yes please\r' });
    const forwarded = window.webContents.sentOn('notifications:onConfirmationForwarded');
    expect(forwarded[0][0]).toEqual({
      projectId: 'p1',
      sessionId: 'tab-9',
      text: 'yes please',
    });
    expect(electronState.windows).toHaveLength(1);
  });

  it('ignores a reply that came from another chat', async () => {
    telegram = await startHttpServer((request, response) => {
      const url = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      if (url.includes('sendMessage')) {
        response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        return;
      }
      response.end(
        JSON.stringify({
          ok: true,
          result: [{ update_id: 3, message: { chat: { id: 999 }, text: 'not for you' } }],
        }),
      );
    });
    redirectTelegramToLocal(telegram.url);
    userData.writeData('settings.json', { telegramBotToken: 'tok', telegramChatId: '-100' });
    seedProject();
    sessionsByProject.set('p1', 'tab-9');
    const file = await startAndRead();

    await post(file.port, '/hook', { projectId: 'p1', kind: 'confirmation' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    // A stranger messaging the bot must never be able to answer a confirmation.
    expect(writes).toEqual([]);
  });
});

describe('stopHookServer', () => {
  it('closes the port so nothing answers on it any more', async () => {
    const file = await startAndRead();
    const module = await import('./hookServer');

    module.stopHookServer();
    stopServer = null;

    await expect(post(file.port, '/hook', { projectId: 'p1', kind: 'pet' })).rejects.toThrow();
  });
});
