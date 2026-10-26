import type { IStreamSubscriber } from '@microsoft/signalr';
import { describe, expect, it, vi } from 'vitest';
import type {
  ExecOutput,
  ExecRequest,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { ApprovalRequiredError } from '../../agents/sshTaskRunner';
import { execApprovalMessage } from './approvals';
import { APPROVAL_INVALID, CORE_ASKS, coreExecutor, NEEDS_APPROVAL } from './coreExecutor';

vi.mock('../../agents/sshTaskRunner', () => ({
  ApprovalRequiredError: class ApprovalRequiredError extends Error {},
}));

/**
 * The executor alone, on a hand-driven stream: what the loop gets back for each way a command can
 * end, and that stopping the run ends the stream (which stops the command on the server).
 */

type Script = (subscriber: IStreamSubscriber<ExecOutput>, request: ExecRequest) => void;

function hubWith(script: Script) {
  const requests: ExecRequest[] = [];
  const disposed = vi.fn();
  const hub = {
    streamExec: (request: ExecRequest) => ({
      subscribe: (subscriber: IStreamSubscriber<ExecOutput>) => {
        requests.push(request);
        queueMicrotask(() => script(subscriber, request));
        return { dispose: disposed };
      },
    }),
  } as unknown as ICoreHub;
  return { hub, requests, disposed };
}

function executorFor(hub: ICoreHub, onLines = vi.fn()) {
  const approve = vi.fn(async () => ({ nonceId: 'n-1', signature: 'sig' }));
  const execute = coreExecutor(
    { links: { call: async (_serverId, work) => work(hub) }, approve, onLines },
    'srv-1',
  );
  return { execute, approve, onLines };
}

const out = (text: string, extra: Partial<ExecOutput> = {}): ExecOutput => ({
  lines: [{ stream: 'out', text }],
  ended: false,
  timedOut: false,
  truncated: false,
  ...extra,
});

describe('coreExecutor', () => {
  it('collects the output and the exit code, and sends approved commands with an approval', async () => {
    const { hub, requests } = hubWith((subscriber) => {
      subscriber.next(out('first'));
      subscriber.next(out('second'));
      subscriber.next({ lines: [], ended: true, exitCode: 3, timedOut: false, truncated: false });
      subscriber.complete();
    });
    const { execute, approve, onLines } = executorFor(hub);

    const result = await execute({ signal: new AbortController().signal }, 'df -h', true);

    expect(result).toEqual({ output: 'first\nsecond', exitCode: 3, timedOut: false });
    expect(approve).toHaveBeenCalledWith('srv-1', hub, 'df -h');
    expect(requests[0]).toEqual({
      command: 'df -h',
      fromAssistant: true,
      timeoutSeconds: 300,
      approval: { nonceId: 'n-1', signature: 'sig' },
    });
    expect(onLines).toHaveBeenCalledTimes(2);
  });

  it('sends an unattended command without an approval and says when it timed out or was cut', async () => {
    const { hub, requests } = hubWith((subscriber) => {
      subscriber.next({ lines: [], ended: true, timedOut: true, truncated: true });
      subscriber.complete();
    });
    const { execute, approve } = executorFor(hub);
    const result = await execute({ signal: new AbortController().signal }, 'uptime', false);
    expect(approve).not.toHaveBeenCalled();
    expect(requests[0]?.approval).toBeUndefined();
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain('Output cut short');
  });

  it('asks the loop for an approval when the core will not run it unattended', async () => {
    const { hub } = hubWith((subscriber) =>
      subscriber.error(new Error(`HubException: ${NEEDS_APPROVAL}`)),
    );
    const { execute } = executorFor(hub);
    const refused = await execute(
      { signal: new AbortController().signal },
      'rm -rf /',
      false,
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApprovalRequiredError);
    expect((refused as Error).message).toBe(CORE_ASKS);
  });

  it('reports any other refusal, or one after an approval, as a command that did not run', async () => {
    const { hub } = hubWith((subscriber) =>
      subscriber.error(new Error(`HubException: ${APPROVAL_INVALID} Approve it again.`)),
    );
    const { execute } = executorFor(hub);
    expect(await execute({ signal: new AbortController().signal }, 'x', true)).toEqual({
      output: `[Not run: ${APPROVAL_INVALID} Approve it again.]`,
      exitCode: null,
      timedOut: false,
    });

    const needs = hubWith((subscriber) => subscriber.error(new Error(NEEDS_APPROVAL)));
    const again = executorFor(needs.hub);
    expect((await again.execute({ signal: new AbortController().signal }, 'x', true)).output).toBe(
      `[Not run: ${NEEDS_APPROVAL}]`,
    );
  });

  it('ends the stream when the run is stopped, keeping what arrived', async () => {
    const { hub, disposed } = hubWith((subscriber) => subscriber.next(out('partial')));
    const { execute } = executorFor(hub);
    const controller = new AbortController();
    const running = execute({ signal: controller.signal }, 'docker logs api', false);
    await vi.waitFor(() => expect(disposed).not.toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await running).toEqual({ output: 'partial', exitCode: null, timedOut: false });
    expect(disposed).toHaveBeenCalled();

    const already = new AbortController();
    already.abort();
    expect((await execute({ signal: already.signal }, 'uptime', false)).output).toBe('');
  });
});

describe('execApprovalMessage', () => {
  it('is the core’s message, one field per line, the command last', () => {
    expect(execApprovalMessage('n', 'abc', 'dev', 'ses', 'df -h\nuptime')).toBe(
      'runova-core/exec/v1\nn\nabc\ndev\nses\ndf -h\nuptime',
    );
  });
});
