import { type IStreamResult, Subject } from '@microsoft/signalr';
import type {
  ConsoleInput,
  ConsoleOutput,
  ConsoleRequest,
  ContainerLogBatch,
  ContainerLogLine,
  ContainerStatsBatch,
  DockerEvent,
} from '../../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/AgentMate.ServerCore.Contracts';
import { hubMessage } from '../connection/hubErrors';
import type { LinkFeed } from './feeds';

/**
 * The Docker streams a server's link keeps open (E06), each with what it needs to carry on after
 * the connection changes: a log goes on after the last line's timestamp, engine events after the
 * last cursor, and stats simply start again. A console cannot be carried over (the shell lived
 * on the old connection), so it opens a new one and says so.
 */

const REOPEN_AFTER_END_MS = 1_000;
const REOPEN_AFTER_FAILURE_MS = 5_000;
/** Docker may be down or still starting; the shared streams keep trying, a little slower. */
const REOPEN_ENGINE_MS = 10_000;
/** The core refuses a stream over its per-connection limit, and counts a closed one a moment more. */
export const STREAMS_BUSY = /streams open/;
/** As much stats history as a window that joins late gets: two minutes at two seconds. */
const KEPT_STATS_BATCHES = 60;
export const STATS_INTERVAL_MS = 2_000;

export interface StatsListener {
  batch(batch: ContainerStatsBatch): void;
  /** The stream failed; it is being tried again. */
  failed?(message: string): void;
}

/** Every running container's figures, shared by everyone who watches the server. */
export class ContainerStatsFeed implements LinkFeed<ContainerStatsBatch> {
  private readonly recent: ContainerStatsBatch[] = [];
  private readonly subscribers = new Set<StatsListener>();

  get listeners(): number {
    return this.subscribers.size;
  }

  open(hub: ICoreHub): IStreamResult<ContainerStatsBatch> {
    return hub.streamContainerStats({ intervalMs: STATS_INTERVAL_MS });
  }

  next(batch: ContainerStatsBatch): void {
    const last = this.recent.at(-1);
    if (last && batch.atUnixMs <= last.atUnixMs) return;
    this.recent.push(batch);
    if (this.recent.length > KEPT_STATS_BATCHES) this.recent.shift();
    for (const listener of [...this.subscribers]) listener.batch(batch);
  }

  ended(): number {
    // The core lost the engine; a new stream finds it again (or fails until it is back).
    return REOPEN_AFTER_END_MS;
  }

  failed(error: Error): number {
    if (STREAMS_BUSY.test(error.message)) return REOPEN_AFTER_FAILURE_MS;
    const message = hubMessage(error);
    for (const listener of [...this.subscribers]) listener.failed?.(message);
    return REOPEN_ENGINE_MS;
  }

  /** Hands over the last couple of minutes first, then every new batch. */
  listen(listener: StatsListener): () => void {
    for (const batch of this.recent) listener.batch(batch);
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
}

/** Engine events in order, from when the feed first opened. Shared by everyone. */
export class DockerEventsFeed implements LinkFeed<DockerEvent> {
  private cursor: string | undefined;
  private readonly subscribers = new Set<(event: DockerEvent) => void>();

  get listeners(): number {
    return this.subscribers.size;
  }

  open(hub: ICoreHub): IStreamResult<DockerEvent> {
    return hub.streamDockerEvents(this.cursor === undefined ? {} : { afterCursor: this.cursor });
  }

  next(event: DockerEvent): void {
    if (this.cursor !== undefined && BigInt(event.cursor) <= BigInt(this.cursor)) return;
    this.cursor = event.cursor;
    for (const listener of [...this.subscribers]) listener(event);
  }

  ended(): number {
    return REOPEN_AFTER_END_MS;
  }

  failed(error: Error): number {
    return STREAMS_BUSY.test(error.message) ? REOPEN_AFTER_FAILURE_MS : REOPEN_ENGINE_MS;
  }

  listen(listener: (event: DockerEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
}

export interface ContainerLogsFeedEvents {
  lines(lines: ContainerLogLine[]): void;
  /** The log is over: not followed, the container stopped, or the core refused to show it. */
  ended(end: { error?: string }): void;
}

export interface ContainerLogsOptions {
  containerId: string;
  tail?: number;
  sinceUnixMs?: number;
  follow: boolean;
}

/** One container's log, from the tail (or a time) on; after a reconnect, from the last line. */
export class ContainerLogsFeed implements LinkFeed<ContainerLogBatch> {
  private after: string | undefined;

  constructor(
    private readonly options: ContainerLogsOptions,
    private readonly events: ContainerLogsFeedEvents,
  ) {}

  open(hub: ICoreHub): IStreamResult<ContainerLogBatch> {
    const { containerId, follow } = this.options;
    if (this.after !== undefined) {
      return hub.streamContainerLogs({ containerId, follow, afterTimestamp: this.after });
    }
    return hub.streamContainerLogs({
      containerId,
      follow,
      ...(this.options.tail === undefined ? {} : { tail: this.options.tail }),
      ...(this.options.sinceUnixMs === undefined ? {} : { sinceUnixMs: this.options.sinceUnixMs }),
    });
  }

  next(batch: ContainerLogBatch): void {
    if (batch.lines.length === 0) return;
    this.after = batch.lines[batch.lines.length - 1].timestamp;
    this.events.lines(batch.lines);
  }

  ended(): null {
    this.events.ended({});
    return null;
  }

  failed(error: Error): number | null {
    if (STREAMS_BUSY.test(error.message)) return REOPEN_AFTER_FAILURE_MS;
    this.events.ended({ error: hubMessage(error) });
    return null;
  }
}

export interface ConsoleFeedEvents {
  /** What the shell printed; `restarted` on the first output of a shell opened after a change. */
  output(data: string, restarted: boolean): void;
  ended(end: { exitCode?: number; error?: string }): void;
}

/** Said when a console that runs a chosen command loses its connection. */
export const COMMAND_NOT_RERUN =
  'The connection to the server changed, so the command was not run again.';

/**
 * A terminal in a container. Keystrokes and size changes go into the current stream's input;
 * when the connection changes under it, a new shell opens at the last known size, and its first
 * output is marked as a restart so the screen can say that the old shell is gone. A chosen
 * command is never started twice (it could be a migration), so that console ends instead.
 */
export class ConsoleFeed implements LinkFeed<ConsoleOutput> {
  private input: Subject<ConsoleInput> | null = null;
  private opens = 0;
  /** The core took the command, so it may have run. */
  private ran = false;
  private freshShell = false;
  private exitCode: number | undefined;
  private finished = false;
  private columns: number;
  private rows: number;

  constructor(
    private readonly request: ConsoleRequest,
    private readonly events: ConsoleFeedEvents,
  ) {
    this.columns = request.columns;
    this.rows = request.rows;
  }

  open(hub: ICoreHub): IStreamResult<ConsoleOutput> {
    this.input?.complete();
    if (this.request.command && this.ran) throw new Error(COMMAND_NOT_RERUN);
    this.ran = true;
    const input = new Subject<ConsoleInput>();
    this.input = input;
    this.opens += 1;
    this.freshShell = this.opens > 1;
    return hub.containerConsole({ ...this.request, columns: this.columns, rows: this.rows }, input);
  }

  next(output: ConsoleOutput): void {
    if (output.ended) {
      this.finished = true;
      this.exitCode = output.exitCode;
      return;
    }
    if (!output.data) return;
    const restarted = this.freshShell;
    this.freshShell = false;
    this.events.output(output.data, restarted);
  }

  ended(): null {
    this.close();
    this.events.ended(
      this.finished && this.exitCode !== undefined ? { exitCode: this.exitCode } : {},
    );
    return null;
  }

  failed(error: Error): number | null {
    if (STREAMS_BUSY.test(error.message)) {
      // Refused before anything started, so the command is still to run.
      this.ran = false;
      return REOPEN_AFTER_FAILURE_MS;
    }
    this.close();
    this.events.ended({ error: hubMessage(error) });
    return null;
  }

  /** Keystrokes for the shell; false when no shell is open to take them. */
  write(data: string): boolean {
    if (!this.input) return false;
    this.input.next({ data });
    return true;
  }

  resize(columns: number, rows: number): boolean {
    this.columns = columns;
    this.rows = rows;
    if (!this.input) return false;
    this.input.next({ columns, rows });
    return true;
  }

  /** Ends the input, which ends the shell on the core's side. */
  close(): void {
    this.input?.complete();
    this.input = null;
  }
}
