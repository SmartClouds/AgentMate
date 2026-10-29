import type { DockerLogLine } from '@shared/apiTypes';
import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithProviders } from '../../../../test/renderer/renderWithProviders';
import { LOG_POLL_MS, useDockerLogs } from './useDockerLogs';

/**
 * A local container's log, read with `docker logs` and then, while following, read again every
 * couple of seconds for only what came since the last line. Lines must never repeat and a
 * failed read must never wipe what is already on screen.
 */

const logs = vi.fn();

function line(second: number, text: string, stream: DockerLogLine['stream'] = 'stdout') {
  const time = `2024-05-01T10:00:${String(second).padStart(2, '0')}`;
  return {
    stream,
    timestamp: `${time}.000000000Z`,
    atUnixMs: Date.parse(`${time}.000Z`),
    text,
  } satisfies DockerLogLine;
}

interface Props {
  id: string | null;
  tail: number;
  follow: boolean;
}

function render(initial: Props) {
  return renderHookWithProviders(
    (props: Props) => useDockerLogs(props.id, { tail: props.tail, follow: props.follow }),
    { initialProps: initial, bridge: { 'docker.logs': logs } },
  );
}

async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LOG_POLL_MS + 50);
  });
}

beforeEach(() => {
  logs.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDockerLogs', () => {
  it('reads the last lines of the container', async () => {
    logs.mockResolvedValue([line(0, 'booting'), line(1, 'ready')]);
    const { result } = render({ id: 'c1', tail: 500, follow: false });

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.lines.map((l) => l.text)).toEqual(['booting', 'ready']);
    expect(logs).toHaveBeenCalledWith('c1', { tail: 500 });
  });

  it('reads nothing without a container', async () => {
    const { result } = render({ id: null, tail: 500, follow: true });

    await act(async () => {
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(logs).not.toHaveBeenCalled();
    expect(result.current.lines).toEqual([]);
  });

  it('while following, asks only for what came since the last line and adds it once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    logs.mockResolvedValueOnce([line(0, 'booting'), line(1, 'ready')]);
    const { result } = render({ id: 'c1', tail: 500, follow: true });
    await waitFor(() => expect(result.current.lines).toHaveLength(2));

    // Docker's --since includes the line at that exact time, so it comes back again.
    logs.mockResolvedValueOnce([line(1, 'ready'), line(2, 'GET / 200')]);
    await tick();

    expect(logs).toHaveBeenLastCalledWith('c1', {
      tail: 500,
      since: '2024-05-01T10:00:01.000000000Z',
    });
    expect(result.current.lines.map((l) => l.text)).toEqual(['booting', 'ready', 'GET / 200']);
  });

  it('reads the whole tail again while a followed log is still empty', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    logs.mockResolvedValue([]);
    const { result } = render({ id: 'c1', tail: 100, follow: true });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await tick();

    expect(logs).toHaveBeenLastCalledWith('c1', { tail: 100 });
  });

  it('does not read again when not following', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    logs.mockResolvedValue([line(0, 'done')]);
    const { result } = render({ id: 'c1', tail: 500, follow: false });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await tick();
    await tick();

    expect(logs).toHaveBeenCalledTimes(1);
  });

  it('starts over with the new number of lines when the tail changes', async () => {
    logs.mockResolvedValueOnce([line(0, 'a')]);
    const { result, rerender } = render({ id: 'c1', tail: 100, follow: false });
    await waitFor(() => expect(result.current.lines).toHaveLength(1));

    logs.mockResolvedValueOnce([line(0, 'a'), line(1, 'b'), line(2, 'c')]);
    rerender({ id: 'c1', tail: 1000, follow: false });

    await waitFor(() => expect(result.current.lines).toHaveLength(3));
    expect(logs).toHaveBeenLastCalledWith('c1', { tail: 1000 });
  });

  it("says why the log couldn't be read, and reads it again on reload", async () => {
    logs.mockRejectedValueOnce(new Error('No such container: c1'));
    const { result } = render({ id: 'c1', tail: 500, follow: false });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('No such container: c1');

    logs.mockResolvedValueOnce([line(0, 'back')]);
    act(() => result.current.reload());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.lines.map((l) => l.text)).toEqual(['back']);
    expect(result.current.error).toBeNull();
  });

  it('keeps the lines it has when a later read fails, and clears the problem once one works', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    logs.mockResolvedValueOnce([line(0, 'booting')]);
    const { result } = render({ id: 'c1', tail: 500, follow: true });
    await waitFor(() => expect(result.current.lines).toHaveLength(1));

    logs.mockRejectedValueOnce(new Error('daemon went away'));
    await tick();

    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBe('daemon went away');
    expect(result.current.lines.map((l) => l.text)).toEqual(['booting']);

    logs.mockResolvedValueOnce([line(3, 'reconnected')]);
    await tick();

    expect(result.current.error).toBeNull();
    expect(result.current.lines.map((l) => l.text)).toEqual(['booting', 'reconnected']);
  });
});
