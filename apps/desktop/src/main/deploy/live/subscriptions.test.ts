import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AlertInfo,
  MetricsSample,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { metricsSample, sampleAlert, sampleJob } from '../../../shared/deploy/testing/fakeCoreData';
import { IPC } from '../../../shared/ipcChannels';
import type { CoreLinks } from './coreLinks';
import type { JobFeedEvents } from './feeds';
import { DeploySubscriptions, type SubscriptionOwner } from './subscriptions';

/**
 * Live data for the renderer: each subscription belongs to the window that made it, its events
 * go to that window only and in batches (a burst of replayed samples or log lines is one IPC
 * message), and they all stop when the window goes away.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function owner(id: number) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const value: SubscriptionOwner = {
    id,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  return { owner: value, sent };
}

function fakeLinks() {
  const metrics: Array<{ listener: (sample: MetricsSample) => void; stop: () => void }> = [];
  const alerts: Array<{ listener: (alert: AlertInfo) => void; stop: () => void }> = [];
  const jobs: Array<{ events: JobFeedEvents; stop: () => void }> = [];
  const links = {
    watchMetrics: vi.fn((_serverId: string, _interval: number, listener) => {
      const entry = { listener, stop: vi.fn() };
      metrics.push(entry);
      return entry.stop;
    }),
    watchAlerts: vi.fn((_serverId: string, listener) => {
      const entry = { listener, stop: vi.fn() };
      alerts.push(entry);
      return entry.stop;
    }),
    watchJob: vi.fn((_serverId: string, _jobId: string, _afterSeq: number, events) => {
      const entry = { events, stop: vi.fn() };
      jobs.push(entry);
      return entry.stop;
    }),
  };
  return { links, metrics, alerts, jobs };
}

function setup(options: { maxPerOwner?: number } = {}) {
  const fake = fakeLinks();
  let next = 0;
  const subscriptions = new DeploySubscriptions({
    links: fake.links as unknown as CoreLinks,
    newId: () => `sub-${++next}`,
    ...options,
  });
  return { ...fake, subscriptions };
}

describe('DeploySubscriptions', () => {
  it('sends samples to the window that asked, in one message per burst', async () => {
    const { subscriptions, metrics, links } = setup();
    const main = owner(1);

    const id = subscriptions.watchMetrics(main.owner, {
      serverId: 'srv-1',
      intervalMs: 2_000,
      sinceUnixMs: 50,
    });
    for (const at of [100, 200, 300]) metrics[0].listener(metricsSample(at));
    await vi.advanceTimersByTimeAsync(150);
    metrics[0].listener(metricsSample(400));
    await vi.advanceTimersByTimeAsync(150);

    expect(id).toBe('sub-1');
    expect(links.watchMetrics).toHaveBeenCalledWith('srv-1', 2_000, expect.any(Function), 50);
    expect(main.sent.map((one) => one.channel)).toEqual([
      IPC.deploySystem.onMetrics,
      IPC.deploySystem.onMetrics,
    ]);
    expect(main.sent[0].payload).toMatchObject({ subscriptionId: 'sub-1', serverId: 'srv-1' });
    expect(
      (main.sent[0].payload as { samples: MetricsSample[] }).samples.map((s) => s.atUnixMs),
    ).toEqual([100, 200, 300]);
  });

  it('watches at two seconds when no interval is given', () => {
    const { subscriptions, links } = setup();

    subscriptions.watchMetrics(owner(1).owner, { serverId: 'srv-1' });

    expect(links.watchMetrics).toHaveBeenCalledWith(
      'srv-1',
      2_000,
      expect.any(Function),
      undefined,
    );
  });

  it("sends a job's lines in batches, and its end at once, then forgets it", async () => {
    const { subscriptions, jobs } = setup();
    const main = owner(1);
    subscriptions.watchJob(main.owner, { serverId: 'srv-1', jobId: 'job-1', afterSeq: 2 });
    const line = (seq: number) => ({ seq, atUnixMs: seq, source: 'out' as const, text: `l${seq}` });

    jobs[0].events.lines([line(3)], sampleJob());
    jobs[0].events.lines([line(4)]);
    jobs[0].events.ended({ job: sampleJob({ state: 'succeeded' }) });

    expect(main.sent).toHaveLength(1);
    expect(main.sent[0]).toMatchObject({
      channel: IPC.deployJobs.onLog,
      payload: {
        subscriptionId: 'sub-1',
        jobId: 'job-1',
        lines: [{ seq: 3 }, { seq: 4 }],
        job: { state: 'succeeded' },
        ended: {},
      },
    });
    expect(subscriptions.count(1)).toBe(0);
  });

  it('drops pending job lines when the window lets the log go', async () => {
    const { subscriptions, jobs } = setup();
    const main = owner(1);
    const id = subscriptions.watchJob(main.owner, { serverId: 'srv-1', jobId: 'job-1' });
    jobs[0].events.lines([{ seq: 1, atUnixMs: 1, source: 'out', text: 'l1' }], sampleJob());

    expect(subscriptions.unwatch(main.owner, 'job', id)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);

    expect(main.sent).toEqual([]);
    expect(jobs[0].stop).toHaveBeenCalled();
  });

  it('says why a job log ended when the core refused it', () => {
    const { subscriptions, jobs } = setup();
    const main = owner(1);
    subscriptions.watchJob(main.owner, { serverId: 'srv-1', jobId: 'job-1' });

    jobs[0].events.ended({ error: 'There is no such job.' });

    expect(main.sent[0].payload).toMatchObject({
      lines: [],
      ended: { error: 'There is no such job.' },
    });
  });

  it('batches alert changes too', async () => {
    const { subscriptions, alerts } = setup();
    const main = owner(1);
    subscriptions.watchAlerts(main.owner, 'srv-1');

    alerts[0].listener(sampleAlert({ id: 1, revision: 1 }));
    alerts[0].listener(sampleAlert({ id: 2, revision: 2 }));
    await vi.advanceTimersByTimeAsync(150);

    expect(main.sent).toEqual([
      {
        channel: IPC.deployAlerts.onChanged,
        payload: {
          subscriptionId: 'sub-1',
          serverId: 'srv-1',
          alerts: [expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 2 })],
        },
      },
    ]);
  });

  it('only lets a window stop its own subscriptions, of the kind it names', () => {
    const { subscriptions, metrics } = setup();
    const main = owner(1);
    const other = owner(2);
    const id = subscriptions.watchMetrics(main.owner, { serverId: 'srv-1' });

    expect(subscriptions.unwatch(other.owner, 'metrics', id)).toBe(false);
    expect(subscriptions.unwatch(main.owner, 'alerts', id)).toBe(false);
    expect(metrics[0].stop).not.toHaveBeenCalled();

    expect(subscriptions.unwatch(main.owner, 'metrics', id)).toBe(true);
    expect(metrics[0].stop).toHaveBeenCalledTimes(1);
  });

  it('stops everything a window had when it goes away, pending batches included', async () => {
    const { subscriptions, metrics, alerts } = setup();
    const main = owner(1);
    subscriptions.watchMetrics(main.owner, { serverId: 'srv-1' });
    subscriptions.watchAlerts(main.owner, 'srv-1');
    metrics[0].listener(metricsSample(1));

    subscriptions.dropOwner(1);
    await vi.advanceTimersByTimeAsync(500);

    expect(metrics[0].stop).toHaveBeenCalled();
    expect(alerts[0].stop).toHaveBeenCalled();
    expect(main.sent).toEqual([]);
    expect(subscriptions.count(1)).toBe(0);
  });

  it('refuses a window that keeps opening subscriptions', () => {
    const { subscriptions } = setup({ maxPerOwner: 2 });
    const main = owner(1);
    subscriptions.watchAlerts(main.owner, 'srv-1');
    subscriptions.watchAlerts(main.owner, 'srv-2');

    expect(() => subscriptions.watchAlerts(main.owner, 'srv-3')).toThrow(/Too many/);
  });
});
