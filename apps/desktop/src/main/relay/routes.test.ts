import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../test/main/ipcHarness';

/** The Relay routes on the loopback hook server: who may ask, and what comes back when. */

vi.mock('../ipc/terminal', () => ({
  SESSION_ID_PATTERN: /^[A-Za-z0-9_-]{1,128}$/,
  findSessionIdForProject: () => null,
  writeToSession: () => undefined,
}));
vi.mock('../agents/statusTracker', () => ({
  agentStatus: { hook: () => true, runInfo: async () => undefined },
}));
vi.mock('../notifications/petNotifier', () => ({ speakOnPet: () => true }));
vi.mock('../ipc/send', () => ({ broadcastToWindows: () => undefined }));

useTempUserData();

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

async function start() {
  const hook = await import('../notifications/hookServer');
  await hook.startHookServer();
  stop = hook.stopHookServer;
  const file = JSON.parse(readFileSync(hook.portFilePath(), 'utf-8')) as {
    port: number;
    token: string;
  };
  return { hook, ...file };
}

async function post(port: number, path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as unknown) : null };
}

describe('POST /relay-gate', () => {
  it('refuses a request without the right secret, before asking the relay', async () => {
    const { hook, port, token } = await start();
    const gate = vi.fn(async () => ({ decision: 'block', reason: 'x' }));
    hook.setRelayHttpHandlers({ gate, mcp: vi.fn(), agentEvent: vi.fn() });
    expect((await post(port, '/relay-gate', { sessionId: 'a' })).status).toBe(401);
    expect(
      (await post(port, '/relay-gate', { token: 'f'.repeat(token.length), sessionId: 'a' })).status,
    ).toBe(401);
    expect((await post(port, '/relay-gate', 'not json')).status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });

  it('answers with what the relay decided, or with no content', async () => {
    const { hook, port, token } = await start();
    const gate = vi
      .fn()
      .mockResolvedValueOnce({ decision: 'block', reason: 'Write the handoff.' })
      .mockResolvedValueOnce(null);
    hook.setRelayHttpHandlers({ gate, mcp: vi.fn(), agentEvent: vi.fn() });
    expect(await post(port, '/relay-gate', { token, sessionId: 'tab-1', event: 'Stop' })).toEqual({
      status: 200,
      json: { decision: 'block', reason: 'Write the handoff.' },
    });
    expect(gate.mock.calls[0][0]).toMatchObject({ sessionId: 'tab-1', event: 'Stop' });
    expect((await post(port, '/relay-gate', { token, sessionId: 'tab-1' })).status).toBe(204);
  });

  it('gives up with no content when the relay is slow', async () => {
    const { hook, port, token } = await start();
    hook.setRelayHttpHandlers({
      gate: () => new Promise((resolve) => setTimeout(() => resolve({ decision: 'block' }), 4000)),
      mcp: vi.fn(),
      agentEvent: vi.fn(),
    });
    const started = Date.now();
    expect((await post(port, '/relay-gate', { token })).status).toBe(204);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('answers no content when no relay is listening', async () => {
    const { hook, port, token } = await start();
    hook.setRelayHttpHandlers(null);
    expect((await post(port, '/relay-gate', { token })).status).toBe(204);
  });
});

describe('POST /relay', () => {
  it('passes a tool call to the relay with the secret checked', async () => {
    const { hook, port, token } = await start();
    const mcp = vi.fn(async () => ({ status: 200, payload: { ok: true, text: 'T001' } }));
    hook.setRelayHttpHandlers({ gate: vi.fn(), mcp, agentEvent: vi.fn() });
    expect((await post(port, '/relay', { tool: 'current_leg' })).status).toBe(401);
    expect(await post(port, '/relay', { token, sessionId: 'tab-1', tool: 'current_leg' })).toEqual({
      status: 200,
      json: { ok: true, text: 'T001' },
    });
  });
});

describe('agent events', () => {
  it('tells the relay about each status hook, with the permission mode', async () => {
    const { hook, port, token } = await start();
    const agentEvent = vi.fn();
    hook.setRelayHttpHandlers({ gate: vi.fn(), mcp: vi.fn(), agentEvent });
    await post(port, '/agent-event', {
      token,
      sessionId: 'tab-1',
      event: 'SessionStart',
      permissionMode: 'plan',
    });
    await vi.waitFor(() =>
      expect(agentEvent).toHaveBeenCalledWith('tab-1', 'SessionStart', 'plan'),
    );
  });
});
