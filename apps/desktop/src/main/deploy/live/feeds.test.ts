import { describe, expect, it, vi } from 'vitest';
import type { JobInfo } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { metricsSample, sampleAlert, sampleJob } from '../../../shared/deploy/testing/fakeCoreData';
import { streamError } from '../../../shared/deploy/testing/fakeStream';
import { AlertsFeed, JobFeed, MetricsFeed } from './feeds';

/**
 * Each feed remembers where its stream got to (the last sample's time, the last log line, the
 * highest alert revision), opens the next stream from there, and drops anything it already
 * passed on, so a stream that moves to a new connection neither skips nor repeats.
 */

function hub() {
  const stream = { subscribe: vi.fn() };
  return {
    stream,
    hub: {
      streamMetrics: vi.fn(() => stream),
      streamAlerts: vi.fn(() => stream),
      streamJob: vi.fn(() => stream),
    } as unknown as ICoreHub & Record<string, ReturnType<typeof vi.fn>>,
  };
}

describe('MetricsFeed', () => {
  it('opens live at first, then from the last sample it passed on', () => {
    const { hub: core } = hub();
    const feed = new MetricsFeed(2_000);
    feed.open(core);
    feed.next(metricsSample(5_000));

    feed.open(core);

    expect(core.streamMetrics).toHaveBeenNthCalledWith(1, { intervalMs: 2_000 });
    expect(core.streamMetrics).toHaveBeenNthCalledWith(2, {
      intervalMs: 2_000,
      sinceUnixMs: 5_000,
    });
  });

  it('starts from the time its first listener asked for', () => {
    const { hub: core } = hub();
    const feed = new MetricsFeed(1_000, 4_000);

    feed.open(core);

    expect(core.streamMetrics).toHaveBeenCalledWith({ intervalMs: 1_000, sinceUnixMs: 4_000 });
  });

  it('passes each sample on once, in order, to every listener', () => {
    const feed = new MetricsFeed(1_000);
    const first: number[] = [];
    const second: number[] = [];
    feed.listen((sample) => first.push(sample.atUnixMs));
    const stop = feed.listen((sample) => second.push(sample.atUnixMs));

    for (const at of [1_000, 2_000, 2_000, 1_500, 3_000]) feed.next(metricsSample(at));
    stop();
    feed.next(metricsSample(4_000));

    expect(first).toEqual([1_000, 2_000, 3_000, 4_000]);
    expect(second).toEqual([1_000, 2_000, 3_000]);
    expect(feed.listeners).toBe(1);
  });

  it('catches a late listener up from the time it asks for, within the last 15 minutes', () => {
    const feed = new MetricsFeed(1_000);
    for (const at of [60_000, 120_000, 180_000, 20 * 60_000]) feed.next(metricsSample(at));
    const late: number[] = [];

    feed.listen((sample) => late.push(sample.atUnixMs), 100_000);

    // The 1-minute and 2-minute samples are more than 15 minutes older than the newest.
    expect(late).toEqual([20 * 60_000]);
  });

  it('opens a stream the core ended or refused again after a pause', () => {
    const feed = new MetricsFeed(1_000);

    expect(feed.ended()).toBeGreaterThan(0);
    expect(feed.failed(streamError('Something broke.'))).toBeGreaterThan(0);
  });
});

describe('AlertsFeed', () => {
  it('opens with the open alerts at first, then with the changes after the highest revision', () => {
    const { hub: core } = hub();
    const feed = new AlertsFeed();
    feed.open(core);
    feed.next(sampleAlert({ id: 1, revision: 4 }));
    feed.next(sampleAlert({ id: 2, revision: 7 }));

    feed.open(core);

    expect(core.streamAlerts).toHaveBeenNthCalledWith(1, {});
    expect(core.streamAlerts).toHaveBeenNthCalledWith(2, { afterRevision: 7 });
  });

  it("can start after a revision it was given, such as the watcher's saved mark", () => {
    const { hub: core } = hub();

    new AlertsFeed({ afterRevision: 12 }).open(core);

    expect(core.streamAlerts).toHaveBeenCalledWith({ afterRevision: 12 });
  });

  it('drops a change it already passed on', () => {
    const feed = new AlertsFeed();
    const seen: number[] = [];
    feed.listen((alert) => seen.push(alert.revision));

    for (const revision of [1, 2, 2, 1, 3]) feed.next(sampleAlert({ id: revision, revision }));

    expect(seen).toEqual([1, 2, 3]);
  });

  it('keeps the open alerts and hands them to a listener that joins later, oldest first', () => {
    const feed = new AlertsFeed({ keepOpen: true });
    feed.next(sampleAlert({ id: 1, revision: 1 }));
    feed.next(sampleAlert({ id: 2, revision: 2, kind: 'rebootRequired', resource: 'system' }));
    feed.next(sampleAlert({ id: 1, revision: 3, severity: 'critical' }));
    feed.next(sampleAlert({ id: 2, revision: 4, resolvedAtUnixMs: 9 }));
    const late: Array<[number, number]> = [];

    feed.listen((alert) => late.push([alert.id, alert.revision]), { replayOpen: true });

    expect(late).toEqual([[1, 3]]);
  });

  it('opens again at once when the core ends the stream, since that means it fell behind', () => {
    const feed = new AlertsFeed();

    expect(feed.ended()).toBeLessThan(1_000);
    expect(feed.failed(streamError('Something broke.'))).toBeGreaterThan(0);
  });
});

describe('JobFeed', () => {
  function jobFeed(afterSeq = 0) {
    const lines: number[][] = [];
    const jobs: Array<JobInfo | undefined> = [];
    const ends: Array<{ job?: JobInfo; error?: string }> = [];
    const feed = new JobFeed('job-1', afterSeq, {
      lines: (batch, job) => {
        lines.push(batch.map((line) => line.seq));
        jobs.push(job);
      },
      ended: (end) => ends.push(end),
    });
    return { feed, lines, jobs, ends };
  }

  const line = (seq: number) => ({
    seq,
    atUnixMs: seq,
    source: 'out' as const,
    text: `line ${seq}`,
  });

  it('opens after the line it was given, then after the last line it passed on', () => {
    const { hub: core } = hub();
    const { feed } = jobFeed(3);
    feed.open(core);
    feed.next({ lines: [line(4), line(5)], job: sampleJob() });

    feed.open(core);

    expect(core.streamJob).toHaveBeenNthCalledWith(1, 'job-1', 3);
    expect(core.streamJob).toHaveBeenNthCalledWith(2, 'job-1', 5);
  });

  it('passes on only new lines, with the job when the core sends it', () => {
    const { feed, lines, jobs } = jobFeed();

    feed.next({ lines: [line(1), line(2)], job: sampleJob() });
    feed.next({ lines: [line(2), line(3)] });
    feed.next({ lines: [line(1)] });

    expect(lines).toEqual([[1, 2], [3]]);
    expect(jobs[0]?.state).toBe('running');
    expect(jobs[1]).toBeUndefined();
  });

  it('is done once the core ends the stream after the final state', () => {
    const { feed, ends } = jobFeed();
    feed.next({ lines: [], job: sampleJob({ state: 'cancelled' }) });

    expect(feed.ended()).toBeNull();
    expect(ends).toEqual([{ job: expect.objectContaining({ state: 'cancelled' }) }]);
  });

  it('picks up again when a stream ends before the job did', () => {
    const { feed, ends } = jobFeed();
    feed.next({ lines: [line(1)], job: sampleJob() });

    expect(feed.ended()).toBeGreaterThan(0);
    expect(ends).toEqual([]);
  });

  it('is done with the reason when the core refuses the stream', () => {
    const { feed, ends } = jobFeed();

    expect(feed.failed(streamError('There is no such job.'))).toBeNull();
    expect(ends).toEqual([{ error: 'There is no such job.' }]);
  });

  it('tries again when the core still counts a stream that was just closed', () => {
    const { feed, ends } = jobFeed();
    const busy = streamError(
      'This connection already has 4 job streams open. Close one before opening another.',
    );

    expect(feed.failed(busy)).toBeGreaterThan(0);
    expect(ends).toEqual([]);
  });
});
