import type { RdpAgentRequest } from '@shared/apiTypes';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Backend, FakeSession } from '../../../../test/renderer/mocks/ironRdp';
import { currentBridge, type FakeBridge } from '../../../../test/renderer/runovaBridge';
import { type RdpAgentTargets, useRdpAgentBridge } from './useRdpAgentBridge';

let bridge: FakeBridge;
let session: FakeSession;
let canvas: HTMLCanvasElement;

function targets(overrides: Partial<RdpAgentTargets> = {}): RdpAgentTargets {
  return {
    getSession: () => session as never,
    getBackend: () => Backend as never,
    getCanvas: () => canvas,
    ...overrides,
  };
}

function respond() {
  return bridge.$fn('rdpAgent.respond');
}

beforeEach(() => {
  bridge = currentBridge();
  session = new FakeSession();
  session.size = { width: 1920, height: 1080 };
  canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    drawImage: () => undefined,
  })) as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const frameRequest: RdpAgentRequest = {
  requestId: 'r1',
  sessionId: 's1',
  kind: 'frame',
  maxWidth: 1280,
};

describe('useRdpAgentBridge', () => {
  it('answers a frame request with a screenshot of the session', async () => {
    renderHook(() => useRdpAgentBridge('s1', targets()));
    bridge.$emit('rdpAgent.onRequest', frameRequest);

    await waitFor(() =>
      expect(respond()).toHaveBeenCalledWith({
        requestId: 'r1',
        ok: true,
        frame: { png: 'AAAA', width: 1280, height: 720, desktopWidth: 1920, desktopHeight: 1080 },
      }),
    );
  });

  it('plays an input request on the session', async () => {
    renderHook(() => useRdpAgentBridge('s1', targets()));
    bridge.$emit('rdpAgent.onRequest', {
      requestId: 'r2',
      sessionId: 's1',
      kind: 'input',
      ops: [{ kind: 'move', x: 5, y: 6 }],
    } satisfies RdpAgentRequest);

    await waitFor(() => expect(respond()).toHaveBeenCalledWith({ requestId: 'r2', ok: true }));
    expect(session.transactions[0].events).toEqual([{ type: 'mouseMove', x: 5, y: 6 }]);
  });

  it('ignores requests meant for another session', async () => {
    renderHook(() => useRdpAgentBridge('s1', targets()));
    bridge.$emit('rdpAgent.onRequest', { ...frameRequest, sessionId: 'other' });
    bridge.$emit('rdpAgent.onRequest', { ...frameRequest, requestId: 'mine' });

    await waitFor(() =>
      expect(respond()).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'mine' })),
    );
    expect(respond()).toHaveBeenCalledTimes(1);
  });

  it('says the session is not connected before there is one', async () => {
    renderHook(() => useRdpAgentBridge('s1', targets({ getSession: () => null })));
    bridge.$emit('rdpAgent.onRequest', frameRequest);

    await waitFor(() =>
      expect(respond()).toHaveBeenCalledWith({
        requestId: 'r1',
        ok: false,
        error: 'The Remote Desktop session is not connected yet.',
      }),
    );
  });

  it('passes a failure back as an error answer', async () => {
    session.applyInputs = () => {
      throw new Error('session closed');
    };
    renderHook(() => useRdpAgentBridge('s1', targets()));
    bridge.$emit('rdpAgent.onRequest', {
      requestId: 'r3',
      sessionId: 's1',
      kind: 'input',
      ops: [{ kind: 'key', scancode: 0x1c, down: true }],
    } satisfies RdpAgentRequest);

    await waitFor(() =>
      expect(respond()).toHaveBeenCalledWith({
        requestId: 'r3',
        ok: false,
        error: 'session closed',
      }),
    );
    expect(session.releasedAll).toBe(1);
  });

  it('reports a missing canvas as an error', async () => {
    renderHook(() => useRdpAgentBridge('s1', targets({ getCanvas: () => null })));
    bridge.$emit('rdpAgent.onRequest', frameRequest);

    await waitFor(() =>
      expect(respond()).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'r1', ok: false }),
      ),
    );
  });

  it('stops listening when unmounted', () => {
    const { unmount } = renderHook(() => useRdpAgentBridge('s1', targets()));
    expect(bridge.$listenerCount('rdpAgent.onRequest')).toBe(1);
    unmount();
    expect(bridge.$listenerCount('rdpAgent.onRequest')).toBe(0);
  });
});
