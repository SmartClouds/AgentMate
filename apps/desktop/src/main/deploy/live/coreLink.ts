import type { IStreamResult, ISubscription } from '@microsoft/signalr';
import { coreErrorCode, coreErrorMessage } from '../../../shared/coreErrors';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type { DeployConnection, DeployConnectionState } from '../../../shared/deployTypes';
import type { LiveHubSession } from '../connection/liveHub';
import type { LinkFeed } from './feeds';
import { type BlockedState, blockedState } from './linkFailures';

/**
 * A server's lasting connection to its core (E05 T2). It opens when something needs it (a live
 * stream or a short call) and closes a minute after nothing does. Its streams are feeds that
 * know where they got to, so whenever the connection changes they carry on from there:
 *
 * - Before the access token runs out, a fresh connection opens and every stream moves over to
 *   it before the old one closes. The core closes a connection whose token expired, so this is
 *   what keeps the Overview from ever seeing that happen (AC4).
 * - A connection that drops after a healthy while is tried again at once and only reported if
 *   that does not work within a few seconds; one that keeps dropping backs off.
 * - Through a reboot it keeps trying (each attempt opens a fresh SSH connection, tunnel and hub)
 *   and reports "reconnecting" until it is back (AC3).
 * - A failure only the user can fix (an ended session, a revoked device, a locked vault) stops
 *   the attempts until `reset`, `retry` or `wake`.
 */

/** After each failure in a row, how long the next attempt waits; the last one repeats. */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 5_000, 10_000, 10_000, 15_000, 15_000, 30_000];
/** A reconnect this quick is not worth showing: the token ran out, or the network blinked. */
const QUIET_RECONNECT_MS = 3_000;
/** A connection that lasted this long was healthy; one that dropped sooner counts as a failure. */
const STABLE_MS = 10_000;
/** Inside CoreSessions' renewal margin (a minute), so the new connection gets a new token. */
const ROTATE_BEFORE_EXPIRY_MS = 45_000;
const ROTATE_RETRY_MS = 10_000;
/** How long the link stays open once nothing needs it. */
const IDLE_MS = 60_000;
/** How long a short call waits for the connection to come up. */
const CALL_WAIT_MS = 20_000;
/** A replaced connection closes once its calls are done, or after this at the latest. */
const DRAIN_MS = 30_000;

const CLOSED = 'This connection to the server core is closed.';

export interface CoreLinkDeps {
  serverId: string;
  /** Opens one hub connection to the server's core. */
  open: () => Promise<LiveHubSession>;
  onState?: (connection: DeployConnection) => void;
  now?: () => number;
}

interface Live {
  session: LiveHubSession;
  openedAt: number;
  closed: boolean;
  /** Short calls still running on it. */
  calls: number;
  /** Replaced by a newer connection; it closes once its calls are done. */
  retired: boolean;
}

interface Run {
  live: Live | null;
  subscription: ISubscription<unknown> | null;
  /** Names the feed's current stream, so callbacks from an older one are ignored. */
  token: object | null;
  retry: ReturnType<typeof setTimeout> | null;
}

interface Waiter {
  resolve: (live: Live) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type TimerName = 'retry' | 'quiet' | 'rotate' | 'idle';

export class CoreLink {
  private state: DeployConnectionState = 'offline';
  private since: number;
  private message: string | undefined;
  private retryAt: number | undefined;
  private live: Live | null = null;
  private connecting = false;
  /** Moves on with every reset, so a connection opened before it is not kept. */
  private generation = 0;
  /** Failures in a row since the last healthy connection. */
  private attempt = 0;
  private wasOnline = false;
  private blocked: Error | null = null;
  /** The transport the renderer last heard of. */
  private shownTransport: string | undefined;
  private closedForGood = false;
  private calls = 0;
  private readonly feeds = new Map<LinkFeed, Run>();
  private waiters: Waiter[] = [];
  private readonly timers = new Map<TimerName, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;

  constructor(private readonly deps: CoreLinkDeps) {
    this.now = deps.now ?? Date.now;
    this.since = this.now();
  }

  get info(): DeployConnection {
    const transport = this.state === 'online' ? this.live?.session.transport : undefined;
    const pinMismatch = this.blocked !== null && coreErrorCode(this.blocked) === 'tlsPinMismatch';
    return {
      serverId: this.deps.serverId,
      state: this.state,
      since: this.since,
      ...(this.message === undefined ? {} : { message: this.message }),
      ...(this.retryAt === undefined ? {} : { retryAt: this.retryAt }),
      ...(transport === undefined ? {} : { transport }),
      ...(pinMismatch ? { problem: 'tls-pin-mismatch' as const } : {}),
    };
  }

  /** Whether a connection is open right now. */
  get online(): boolean {
    return this.live !== null;
  }

  /** Keeps the feed's stream open on whatever connection is current, until the returned call. */
  attach(feed: LinkFeed): () => void {
    if (this.closedForGood) throw new Error(CLOSED);
    if (!this.feeds.has(feed)) {
      this.feeds.set(feed, { live: null, subscription: null, token: null, retry: null });
      if (this.live) this.start(feed, this.live);
      this.used();
    }
    return () => this.detach(feed);
  }

  /** Runs `work` on the open connection, waiting for one when it is on its way up. */
  async call<T>(work: (hub: ICoreHub) => Promise<T>): Promise<T> {
    if (this.closedForGood) throw new Error(CLOSED);
    if (this.blocked) throw this.blocked;
    this.calls += 1;
    this.used();
    try {
      const live = await this.whenLive();
      live.calls += 1;
      try {
        return await work(live.session.hub);
      } finally {
        live.calls -= 1;
        if (live.retired && live.calls === 0) void live.session.stop();
      }
    } finally {
      this.calls -= 1;
      this.used();
    }
  }

  /** Starts over with a fresh connection, as after signing in or out. */
  reset(): void {
    if (this.closedForGood) return;
    this.generation += 1;
    this.blocked = null;
    this.attempt = 0;
    this.wasOnline = false;
    this.clear('retry', 'quiet', 'rotate');
    const live = this.live;
    this.live = null;
    if (live) this.letGo(live);
    if (this.inUse) void this.connect();
    else this.setState('offline');
  }

  /** Tries again now, whatever it was waiting for. */
  retry(): void {
    if (this.closedForGood || this.live) return;
    this.blocked = null;
    this.attempt = 0;
    this.clear('retry');
    void this.connect();
  }

  /** Tries again if it is waiting in `state`, such as 'locked' once the vault opens. */
  wake(state: BlockedState): void {
    if (this.state === state) this.retry();
  }

  close(): void {
    if (this.closedForGood) return;
    this.closedForGood = true;
    this.clear('retry', 'quiet', 'rotate', 'idle');
    for (const run of this.feeds.values()) {
      if (run.retry) clearTimeout(run.retry);
      run.subscription?.dispose();
    }
    this.feeds.clear();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(CLOSED));
    }
    const live = this.live;
    this.live = null;
    if (live) void live.session.stop();
    this.setState('offline');
  }

  private get inUse(): boolean {
    return this.feeds.size > 0 || this.calls > 0;
  }

  private async connect(): Promise<void> {
    if (this.closedForGood || this.connecting || this.live) return;
    this.connecting = true;
    this.clear('retry');
    const generation = this.generation;
    if (this.state !== 'online' && this.state !== 'reconnecting' && this.retryAt === undefined) {
      this.setState('connecting');
    }
    let session: LiveHubSession;
    try {
      session = await this.deps.open();
    } catch (error) {
      this.connecting = false;
      if (this.closedForGood) return;
      if (generation !== this.generation) void this.connect();
      else this.failed(error);
      return;
    }
    this.connecting = false;
    if (this.closedForGood || generation !== this.generation) {
      void session.stop();
      if (!this.closedForGood) void this.connect();
      return;
    }
    this.adopt(session);
  }

  private adopt(session: LiveHubSession): void {
    const live = this.track(session);
    this.live = live;
    this.wasOnline = true;
    this.blocked = null;
    this.clear('quiet', 'retry');
    this.setState('online');
    for (const feed of this.feeds.keys()) this.start(feed, live);
    this.scheduleRotation(live);
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(live);
    }
    this.used();
  }

  private track(session: LiveHubSession): Live {
    const live: Live = { session, openedAt: this.now(), closed: false, calls: 0, retired: false };
    void session.closed.then(() => this.lost(live));
    return live;
  }

  private failed(error: unknown): void {
    const message = coreErrorMessage(error);
    const blocked = blockedState(error);
    this.clear('quiet');
    if (blocked) {
      this.blocked = error instanceof Error ? error : new Error(message);
      this.setState(blocked, message);
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(this.blocked);
      }
      return;
    }
    if (!this.inUse) {
      // Nothing needs it any more, so there is no point in trying again.
      this.setState('offline', message);
      return;
    }
    this.retryLater(this.wasOnline ? 'reconnecting' : 'offline', message);
  }

  private retryLater(state: DeployConnectionState, message: string): void {
    this.attempt += 1;
    const delay = RETRY_DELAYS_MS[Math.min(this.attempt - 1, RETRY_DELAYS_MS.length - 1)];
    this.later('retry', delay, () => void this.connect());
    this.setState(state, message, this.now() + delay);
  }

  /** The connection closed: the core went away, the token ran out, or it was replaced. */
  private lost(live: Live): void {
    live.closed = true;
    if (live !== this.live) return;
    this.live = null;
    this.clear('rotate');
    for (const run of this.feeds.values()) {
      if (run.live !== live) continue;
      run.live = null;
      run.subscription = null;
      run.token = null;
    }
    if (this.closedForGood) return;
    if (!this.inUse) {
      this.wasOnline = false;
      this.setState('offline');
      return;
    }
    if (this.now() - live.openedAt < STABLE_MS) {
      this.retryLater('reconnecting', 'The connection to the server core keeps closing.');
      return;
    }
    // Most likely its token ran out a little ahead of this computer's clock, or the network
    // blinked: try again at once, and only say so if that does not work out soon.
    this.attempt = 0;
    this.later('quiet', QUIET_RECONNECT_MS, () => {
      if (!this.live) this.setState('reconnecting', this.message, this.retryAt);
    });
    void this.connect();
  }

  private scheduleRotation(live: Live): void {
    const expiresAt = live.session.expiresAt;
    if (expiresAt === null) return;
    const delay = Math.max(0, expiresAt - ROTATE_BEFORE_EXPIRY_MS - this.now());
    this.later('rotate', delay, () => void this.rotate(live));
  }

  /** Opens the next connection while the current one still works, then moves everything over. */
  private async rotate(old: Live): Promise<void> {
    if (old !== this.live || this.closedForGood) return;
    const generation = this.generation;
    let session: LiveHubSession;
    try {
      session = await this.deps.open();
    } catch {
      // The old one carries on; if the core closes it first, the usual reconnect takes over.
      if (old === this.live && !old.closed) {
        this.later('rotate', ROTATE_RETRY_MS, () => void this.rotate(old));
      }
      return;
    }
    if (old !== this.live || old.closed || generation !== this.generation || this.closedForGood) {
      void session.stop();
      return;
    }
    const live = this.track(session);
    this.live = live;
    for (const feed of this.feeds.keys()) this.start(feed, live);
    this.scheduleRotation(live);
    this.retire(old);
  }

  /** Lets go of a connection that is no longer current: its streams now, itself once idle. */
  private letGo(live: Live): void {
    for (const run of this.feeds.values()) {
      if (run.live !== live) continue;
      run.subscription?.dispose();
      run.live = null;
      run.subscription = null;
      run.token = null;
    }
    this.retire(live);
  }

  private retire(live: Live): void {
    live.retired = true;
    if (live.calls === 0) {
      void live.session.stop();
      return;
    }
    setTimeout(() => {
      if (!live.closed) void live.session.stop();
    }, DRAIN_MS);
  }

  /** Opens the feed's stream on `live`, then lets go of the stream it had before, if any. */
  private start(feed: LinkFeed, live: Live): void {
    const run = this.feeds.get(feed);
    if (!run) return;
    if (run.retry) clearTimeout(run.retry);
    run.retry = null;
    const previous = run.subscription;
    const token = {};
    run.token = token;
    run.live = live;
    run.subscription = null;
    let stream: IStreamResult<unknown>;
    try {
      stream = feed.open(live.session.hub);
    } catch (error) {
      this.settle(
        feed,
        run,
        token,
        live,
        error instanceof Error ? error : new Error(String(error)),
      );
      previous?.dispose();
      return;
    }
    const subscription = stream.subscribe({
      next: (item) => {
        if (run.token === token) feed.next(item);
      },
      complete: () => this.settle(feed, run, token, live, null),
      error: (error: unknown) =>
        this.settle(
          feed,
          run,
          token,
          live,
          error instanceof Error ? error : new Error(String(error)),
        ),
    });
    if (run.token === token) run.subscription = subscription;
    previous?.dispose();
  }

  /**
   * A feed's stream ended. SignalR fails every stream of a connection before it reports the
   * connection closed, so the decision waits a turn: a stream lost with its connection is opened
   * again on the next one, while one the core ended or refused is the feed's to answer.
   */
  private settle(feed: LinkFeed, run: Run, token: object, live: Live, error: Error | null): void {
    if (run.token !== token) return;
    run.token = null;
    run.subscription = null;
    setTimeout(() => {
      if (this.feeds.get(feed) !== run || run.token !== null) return;
      if (live.closed || live !== this.live) return;
      const again = error ? feed.failed(error) : feed.ended();
      if (again === null) {
        this.feeds.delete(feed);
        this.used();
        return;
      }
      run.retry = setTimeout(() => {
        run.retry = null;
        if (this.feeds.get(feed) === run && run.token === null && this.live) {
          this.start(feed, this.live);
        }
      }, again);
    }, 0);
  }

  private detach(feed: LinkFeed): void {
    const run = this.feeds.get(feed);
    if (!run) return;
    this.feeds.delete(feed);
    if (run.retry) clearTimeout(run.retry);
    run.token = null;
    run.subscription?.dispose();
    this.used();
  }

  /** Connects when something needs the link, and closes it a while after nothing does. */
  private used(): void {
    if (this.closedForGood) return;
    if (this.inUse) {
      this.clear('idle');
      if (!this.live && !this.connecting && !this.blocked && !this.timers.has('retry')) {
        void this.connect();
      }
      return;
    }
    if (this.timers.has('idle')) return;
    if (this.live || this.connecting || this.timers.has('retry')) {
      this.later('idle', IDLE_MS, () => {
        if (!this.inUse) this.rest();
      });
    }
  }

  /** Nothing needs the link: close it and stop trying. */
  private rest(): void {
    this.clear('retry', 'quiet', 'rotate');
    this.wasOnline = false;
    this.attempt = 0;
    const live = this.live;
    this.live = null;
    if (live) this.letGo(live);
    this.setState('offline');
  }

  private whenLive(): Promise<Live> {
    if (this.live) return Promise.resolve(this.live);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((one) => one !== waiter);
          reject(
            new Error(
              this.message
                ? `Could not reach the server core: ${this.message}`
                : 'Could not reach the server core in time.',
            ),
          );
        }, CALL_WAIT_MS),
      };
      this.waiters.push(waiter);
    });
  }

  private setState(state: DeployConnectionState, message?: string, retryAt?: number): void {
    // A new connection over another transport (direct TLS, then SSH) is news while still online.
    const transport = state === 'online' ? this.live?.session.transport : undefined;
    const changed =
      state !== this.state ||
      message !== this.message ||
      retryAt !== this.retryAt ||
      transport !== this.shownTransport;
    this.shownTransport = transport;
    if (state !== this.state) this.since = this.now();
    this.state = state;
    this.message = message;
    this.retryAt = retryAt;
    if (changed) this.deps.onState?.(this.info);
  }

  private later(name: TimerName, delay: number, run: () => void): void {
    this.clear(name);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        run();
      }, delay),
    );
  }

  private clear(...names: TimerName[]): void {
    for (const name of names) {
      const timer = this.timers.get(name);
      if (timer) clearTimeout(timer);
      this.timers.delete(name);
    }
  }
}
