import type { RdpLinkStats } from '../../shared/apiTypes';

/**
 * What the Remote Desktop window's connection readout shows for one session: how many bytes
 * cross the proxy each way, and about how long the server takes to answer.
 *
 * The answer time is read off the traffic instead of probed. An RDP server only replies when
 * something changed on screen, so there is nothing to ping. Instead, when the server has been
 * quiet for a moment and the window then sends something (a key, a click), the clock starts, and
 * it stops at the next thing the server sends. That reaction time is what makes a connection
 * feel slow or fast, and an unrelated screen update can only make a sample look later than it
 * should, so the middle of the recent samples is used.
 */

/** Rates are averaged over this long, so the readout moves steadily instead of flickering. */
const RATE_WINDOW_MS = 2_000;
/** Traffic is added up in buckets this wide, so a fast download keeps only a handful of entries. */
const BUCKET_MS = 100;
/** The server must have been silent this long for the window's next message to start the clock. */
const QUIET_MS = 120;
/** A reply later than this is more likely a screen update of its own than an answer. */
const MAX_ANSWER_MS = 2_000;
/** Samples older than this say little about the connection now. */
const SAMPLE_TTL_MS = 30_000;
const MAX_SAMPLES = 9;

interface Bucket {
  at: number;
  down: number;
  up: number;
}

interface Sample {
  at: number;
  ms: number;
}

export class LinkMeter {
  private readonly buckets: Bucket[] = [];
  private samples: Sample[] = [];
  private lastDownAt = Number.NEGATIVE_INFINITY;
  /** When the message the clock is running for was sent, or null with no clock running. */
  private clockStartedAt: number | null = null;

  /** `startedAt` is when the connection began, so the first seconds are not averaged over empty time. */
  constructor(private readonly startedAt: number = performance.now()) {}

  /** The server sent `bytes` to the window. */
  recordDown(bytes: number, now: number = performance.now()): void {
    this.addTraffic(now, bytes, 0);
    if (this.clockStartedAt !== null) {
      const ms = now - this.clockStartedAt;
      this.clockStartedAt = null;
      if (ms <= MAX_ANSWER_MS) {
        this.samples.push({ at: now, ms });
        if (this.samples.length > MAX_SAMPLES) this.samples.shift();
      }
    }
    this.lastDownAt = now;
  }

  /** The window sent `bytes` to the server. */
  recordUp(bytes: number, now: number = performance.now()): void {
    this.addTraffic(now, 0, bytes);
    if (this.clockStartedAt !== null && now - this.clockStartedAt > MAX_ANSWER_MS) {
      this.clockStartedAt = null;
    }
    if (this.clockStartedAt === null && now - this.lastDownAt >= QUIET_MS) {
      this.clockStartedAt = now;
    }
  }

  snapshot(now: number = performance.now()): RdpLinkStats {
    this.dropOldTraffic(now);
    let down = 0;
    let up = 0;
    for (const bucket of this.buckets) {
      down += bucket.down;
      up += bucket.up;
    }
    // Early on, only the time that has passed counts, but never less than half a second.
    const windowMs = Math.max(500, Math.min(RATE_WINDOW_MS, now - this.startedAt));
    return {
      downBytesPerSec: (down * 1000) / windowMs,
      upBytesPerSec: (up * 1000) / windowMs,
      latencyMs: this.latency(now),
    };
  }

  private addTraffic(now: number, down: number, up: number): void {
    this.dropOldTraffic(now);
    const last = this.buckets[this.buckets.length - 1];
    if (last && now - last.at < BUCKET_MS) {
      last.down += down;
      last.up += up;
      return;
    }
    this.buckets.push({ at: now, down, up });
  }

  private dropOldTraffic(now: number): void {
    while (this.buckets.length > 0 && this.buckets[0].at <= now - RATE_WINDOW_MS) {
      this.buckets.shift();
    }
  }

  private latency(now: number): number | null {
    this.samples = this.samples.filter((sample) => now - sample.at <= SAMPLE_TTL_MS);
    if (this.samples.length === 0) return null;
    const sorted = this.samples.map((sample) => sample.ms).sort((a, b) => a - b);
    return Math.round(sorted[Math.floor(sorted.length / 2)]);
  }
}
