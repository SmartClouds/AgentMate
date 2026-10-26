import type { RdpAgentRequest, RdpAgentResponse } from '@shared/apiTypes';
import { useEffect, useRef } from 'react';
import { captureFrame } from '@/lib/rdp/agentFrame';
import { applyInputOps, type InputBackend, type InputSession } from '@/lib/rdp/agentInput';

/** The live session parts an AI task works through, read at the moment a request arrives. */
export interface RdpAgentTargets {
  getSession: () => (InputSession & { desktopSize(): { width: number; height: number } }) | null;
  getBackend: () => InputBackend | null;
  getCanvas: () => HTMLCanvasElement | null;
}

const NOT_CONNECTED = 'The Remote Desktop session is not connected yet.';

async function answer(
  request: RdpAgentRequest,
  targets: RdpAgentTargets,
): Promise<RdpAgentResponse> {
  const session = targets.getSession();
  const backend = targets.getBackend();
  if (!session || !backend)
    return { requestId: request.requestId, ok: false, error: NOT_CONNECTED };

  if (request.kind === 'frame') {
    const canvas = targets.getCanvas();
    if (!canvas) {
      return {
        requestId: request.requestId,
        ok: false,
        error: 'The Remote Desktop session has no screen to capture yet.',
      };
    }
    const size = session.desktopSize();
    const frame = captureFrame(
      canvas,
      { width: size.width, height: size.height },
      request.maxWidth,
    );
    return { requestId: request.requestId, ok: true, frame };
  }

  await applyInputOps(session, backend, request.ops);
  return { requestId: request.requestId, ok: true };
}

/**
 * Lets an AI task in the main process see and use this window's Remote Desktop session: it
 * answers screenshot and input requests addressed to `sessionId`, and leaves the rest alone.
 */
export function useRdpAgentBridge(sessionId: string, targets: RdpAgentTargets): void {
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  useEffect(() => {
    return window.runova.rdpAgent.onRequest((request: RdpAgentRequest) => {
      if (request.sessionId !== sessionId) return;
      void answer(request, targetsRef.current)
        .catch(
          (error: unknown): RdpAgentResponse => ({
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .then((response) => window.runova.rdpAgent.respond(response));
    });
  }, [sessionId]);
}
