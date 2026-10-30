import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLiveWindowCache, getLiveWindows } from './claudeAccount';

/**
 * The account's own quota numbers are fetched at most once a minute and shared by every reader. What
 * matters is that each answer carries the time the account gave it, that one bad answer does not
 * keep the real numbers away for long, and that a new grant is never served the old grant's answer.
 */

const NOW = Date.parse('2026-10-19T19:30:00.000Z');
const MINUTE = 60_000;
const PLAN = { id: 'max20x', label: 'Ultra' };

const BODY = {
  five_hour: { utilization: 12, resets_at: '2026-10-19T22:40:00.000Z' },
  seven_day: { utilization: 5, resets_at: '2026-10-26T15:00:00.000Z' },
};

const fetchMock = vi.fn();

function answer(body: unknown = BODY): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function refusal(status: number, retryAfter?: string): Response {
  const headers = retryAfter ? { 'retry-after': retryAfter } : undefined;
  return new Response('{}', { status, headers });
}

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  clearLiveWindowCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the live Claude quota', () => {
  it('comes back with the time the account answered', async () => {
    fetchMock.mockResolvedValueOnce(answer());

    const live = await getLiveWindows('token-a', PLAN);

    expect(live?.readAt).toBe(new Date(NOW).toISOString());
    expect(live?.windows.map((w) => [w.key, w.percent])).toEqual([
      ['session', 12],
      ['week', 5],
    ]);
  });

  it('keeps the original read time when the answer is served from the cache', async () => {
    fetchMock.mockResolvedValueOnce(answer());
    await getLiveWindows('token-a', PLAN);

    advance(40_000);
    const live = await getLiveWindows('token-a', PLAN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(live?.readAt).toBe(new Date(NOW).toISOString());
  });

  it('asks the account again once the answer is a minute old', async () => {
    fetchMock
      .mockResolvedValueOnce(answer())
      .mockResolvedValueOnce(
        answer({ five_hour: { utilization: 20, resets_at: '2026-10-19T22:40:00.000Z' } }),
      );
    await getLiveWindows('token-a', PLAN);

    advance(MINUTE);
    const live = await getLiveWindows('token-a', PLAN);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(live?.windows[0].percent).toBe(20);
    expect(live?.readAt).toBe(new Date(NOW + MINUTE).toISOString());
  });

  it('tries again at the next poll after a timeout or a server error, not minutes later', async () => {
    fetchMock.mockRejectedValueOnce(new Error('aborted')).mockResolvedValueOnce(refusal(503));
    fetchMock.mockResolvedValueOnce(answer());

    expect(await getLiveWindows('token-a', PLAN)).toBeNull();
    advance(MINUTE);
    expect(await getLiveWindows('token-a', PLAN)).toBeNull();
    advance(MINUTE);
    const live = await getLiveWindows('token-a', PLAN);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(live?.windows).toHaveLength(2);
  });

  it('does not ask again within the minute after a failure', async () => {
    fetchMock.mockResolvedValueOnce(refusal(500));
    await getLiveWindows('token-a', PLAN);

    advance(30_000);
    expect(await getLiveWindows('token-a', PLAN)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('backs off for five minutes after a rate limit that names no wait', async () => {
    fetchMock.mockResolvedValueOnce(refusal(429)).mockResolvedValueOnce(answer());
    await getLiveWindows('token-a', PLAN);

    advance(4 * MINUTE);
    expect(await getLiveWindows('token-a', PLAN)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    advance(MINUTE);
    expect(await getLiveWindows('token-a', PLAN)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits as long as a rate limit asks, in seconds or as a date', async () => {
    fetchMock.mockResolvedValueOnce(refusal(429, '120')).mockResolvedValueOnce(answer());
    await getLiveWindows('token-a', PLAN);
    advance(119_000);
    await getLiveWindows('token-a', PLAN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(1_000);
    await getLiveWindows('token-a', PLAN);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clearLiveWindowCache();
    const until = new Date(Date.now() + 3 * MINUTE).toUTCString();
    fetchMock.mockResolvedValueOnce(refusal(429, until)).mockResolvedValueOnce(answer());
    await getLiveWindows('token-a', PLAN);
    advance(2 * MINUTE);
    await getLiveWindows('token-a', PLAN);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    advance(MINUTE);
    await getLiveWindows('token-a', PLAN);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reads a new grant straight away instead of serving the old one its cached answer', async () => {
    fetchMock.mockResolvedValueOnce(refusal(401)).mockResolvedValueOnce(answer());
    expect(await getLiveWindows('expired-token', PLAN)).toBeNull();

    // The CLI refreshed its login a moment later.
    advance(5_000);
    const live = await getLiveWindows('fresh-token', PLAN);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(live?.windows).toHaveLength(2);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fresh-token');
  });

  it('asks again right away once the cache is cleared by a refresh', async () => {
    fetchMock.mockResolvedValueOnce(refusal(429)).mockResolvedValueOnce(answer());
    await getLiveWindows('token-a', PLAN);

    clearLiveWindowCache();
    const live = await getLiveWindows('token-a', PLAN);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(live).not.toBeNull();
  });
});
