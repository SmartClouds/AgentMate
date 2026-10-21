import { describe, expect, it } from 'vitest';
import { LinkMeter } from './linkMeter';

/** Times are in milliseconds from the start of the connection, passed in rather than read. */

describe('LinkMeter speed', () => {
  it('reports nothing before any traffic', () => {
    const meter = new LinkMeter(0);
    expect(meter.snapshot(1_000)).toEqual({
      downBytesPerSec: 0,
      upBytesPerSec: 0,
      latencyMs: null,
    });
  });

  it('averages each direction over the last two seconds', () => {
    const meter = new LinkMeter(0);
    // What came before the last two seconds no longer counts.
    meter.recordDown(999_999, 1_900);
    for (let at = 2_100; at <= 4_000; at += 100) {
      meter.recordDown(10_000, at);
      meter.recordUp(100, at);
    }
    const stats = meter.snapshot(4_000);
    expect(stats.downBytesPerSec).toBe(100_000);
    expect(stats.upBytesPerSec).toBe(1_000);
  });

  it('does not average the first moments over time that has not passed', () => {
    const meter = new LinkMeter(0);
    meter.recordDown(50_000, 400);
    // Half a second is the shortest span a rate is spread over.
    expect(meter.snapshot(500).downBytesPerSec).toBe(100_000);
  });

  it('drops to zero once the traffic stops', () => {
    const meter = new LinkMeter(0);
    meter.recordDown(1_000_000, 5_000);
    expect(meter.snapshot(5_100).downBytesPerSec).toBeGreaterThan(0);
    expect(meter.snapshot(7_500).downBytesPerSec).toBe(0);
  });

  it('counts a burst of small chunks the same as one big one', () => {
    const meter = new LinkMeter(0);
    for (let index = 0; index < 1_000; index++) meter.recordDown(1_000, 3_000 + index / 10);
    expect(meter.snapshot(3_500).downBytesPerSec).toBe(1_000_000 / 2);
  });
});

describe('LinkMeter answer time', () => {
  it('is unknown until something sent was answered', () => {
    const meter = new LinkMeter(0);
    meter.recordUp(20, 1_000);
    expect(meter.snapshot(1_050).latencyMs).toBeNull();
  });

  it('measures from a message after a quiet moment to the next thing the server sends', () => {
    const meter = new LinkMeter(0);
    meter.recordUp(20, 1_000);
    meter.recordDown(900, 1_045);
    expect(meter.snapshot(1_100).latencyMs).toBe(45);
  });

  it('ignores the messages that follow a screen update, such as acknowledgements', () => {
    const meter = new LinkMeter(0);
    meter.recordDown(40_000, 1_000);
    // Sent 30 ms after the update, so the server was not quiet and this is not an input.
    meter.recordUp(10, 1_030);
    meter.recordDown(40_000, 1_040);
    expect(meter.snapshot(1_100).latencyMs).toBeNull();
  });

  it('keeps timing from the first message when more are sent before the answer', () => {
    const meter = new LinkMeter(0);
    meter.recordUp(20, 1_000);
    meter.recordUp(20, 1_020);
    meter.recordDown(500, 1_060);
    expect(meter.snapshot(1_100).latencyMs).toBe(60);
  });

  it('throws out an answer that took too long to be one', () => {
    const meter = new LinkMeter(0);
    meter.recordUp(20, 1_000);
    meter.recordDown(500, 3_500);
    expect(meter.snapshot(3_600).latencyMs).toBeNull();
  });

  it('starts a new measurement after an unanswered message goes stale', () => {
    const meter = new LinkMeter(0);
    meter.recordUp(20, 1_000);
    meter.recordUp(20, 4_000);
    meter.recordDown(500, 4_050);
    expect(meter.snapshot(4_100).latencyMs).toBe(50);
  });

  it('reports the middle of the recent samples, so one odd one does not move it', () => {
    const meter = new LinkMeter(0);
    let at = 1_000;
    for (const ms of [40, 42, 900, 41, 43]) {
      meter.recordUp(20, at);
      meter.recordDown(500, at + ms);
      at += 2_000;
    }
    expect(meter.snapshot(at).latencyMs).toBe(42);
  });

  it('forgets samples that are too old to describe the connection', () => {
    const meter = new LinkMeter(0);
    meter.recordUp(20, 1_000);
    meter.recordDown(500, 1_050);
    expect(meter.snapshot(20_000).latencyMs).toBe(50);
    expect(meter.snapshot(40_000).latencyMs).toBeNull();
  });
});
