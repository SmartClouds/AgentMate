/**
 * How fast a batch moves (E25), for the queue's rate and time left. Bytes are counted over a
 * sliding window, so a burst of progress events reads as the average it is and the rate fades
 * when the transfer stalls, until it goes quiet (null) once the window holds nothing.
 *
 * The clock starts when the meter is made (or `reset`), and again when bytes arrive after the
 * window ran empty, so a batch that sat behind a conflict does not read slow when it resumes.
 * Nothing is said for the first second.
 */

/** How far back the rate looks. */
export const RATE_WINDOW_MS = 5000;
/** The rate needs this much time to go on before it says anything. */
const MIN_SPAN_MS = 1000;
/** Samples this close together share a bucket, so a fast stream keeps the list short. */
const BUCKET_MS = 100;

interface Bucket {
  at: number;
  bytes: number;
}

export class RateMeter {
  private buckets: Bucket[] = [];
  private total = 0;
  private startedAt: number;
  private lastAt: number | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = RATE_WINDOW_MS,
  ) {
    this.startedAt = now();
  }

  /** Counts bytes that just moved. Zero and negative counts are ignored. */
  add(bytes: number): void {
    if (!(bytes > 0)) return;
    const at = this.now();
    this.prune(at);
    if (this.lastAt !== null && at - this.lastAt > this.windowMs) this.startedAt = at;
    this.lastAt = at;
    const last = this.buckets[this.buckets.length - 1];
    if (last && at - last.at < BUCKET_MS) last.bytes += bytes;
    else this.buckets.push({ at, bytes });
    this.total += bytes;
  }

  /** Bytes a second over the window; null for the first second, and when nothing moved in it. */
  bytesPerSecond(): number | null {
    const at = this.now();
    const span = Math.min(at - this.startedAt, this.windowMs);
    if (span < MIN_SPAN_MS) return null;
    this.prune(at);
    if (this.total <= 0) return null;
    return this.total / (span / 1000);
  }

  /** Whole seconds to move `remaining` bytes at the current rate; null when there is no rate. */
  eta(remaining: number): number | null {
    if (remaining <= 0) return 0;
    const rate = this.bytesPerSecond();
    return rate ? Math.ceil(remaining / rate) : null;
  }

  /** Forgets everything and starts the clock again, as a retried batch does. */
  reset(): void {
    this.buckets = [];
    this.total = 0;
    this.lastAt = null;
    this.startedAt = this.now();
  }

  private prune(at: number): void {
    const oldest = at - this.windowMs;
    let drop = 0;
    while (drop < this.buckets.length && this.buckets[drop].at <= oldest) {
      this.total -= this.buckets[drop].bytes;
      drop += 1;
    }
    if (drop > 0) this.buckets = this.buckets.slice(drop);
  }
}
