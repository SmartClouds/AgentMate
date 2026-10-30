import type { IStreamResult, IStreamSubscriber, ISubscription } from '@microsoft/signalr';

/**
 * A hub stream as the JavaScript SignalR client hands it out: nothing flows until `subscribe`,
 * items arrive asynchronously, and disposing the subscription stops everything at once. Errors
 * carry the texts the real client reports, so code that reads them sees what it would in use.
 */

/** What the client says when a hub method threw a HubException. */
export function invocationError(method: string, message: string): Error {
  return new Error(
    `An unexpected error occurred invoking '${method}' on the server. HubException: ${message}`,
  );
}

/** What the client says when a stream method threw a HubException. */
export function streamError(message: string): Error {
  return new Error(
    `An error occurred on the server while streaming results. HubException: ${message}`,
  );
}

/** What the client says when an authorization policy turned the call down (role or step-up). */
export function unauthorizedError(method: string): Error {
  return new Error(`Failed to invoke '${method}' because user is unauthorized`);
}

/** What a call gets when the core could not read its arguments (a value it does not know). */
export function bindingError(method: string): Error {
  return new Error(`Failed to invoke '${method}' due to an error on the server.`);
}

/** What every open stream and call gets when its connection goes away. */
export function connectionClosedError(): Error {
  return new Error('Invocation canceled due to the underlying connection being closed.');
}

export class FakeStream<T> implements IStreamResult<T> {
  private subscriber: IStreamSubscriber<T> | null = null;
  private ended = false;

  /**
   * @param start runs once the stream is subscribed (a microtask later, like a network round
   *   trip): replay what it owes, then call `push` as things happen.
   * @param stopped runs once when the stream ends, whichever side ended it.
   */
  constructor(
    private readonly start: (stream: FakeStream<T>) => void,
    private readonly stopped: (stream: FakeStream<T>) => void = () => undefined,
  ) {}

  get open(): boolean {
    return this.subscriber !== null && !this.ended;
  }

  subscribe(subscriber: IStreamSubscriber<T>): ISubscription<T> {
    this.subscriber = subscriber;
    queueMicrotask(() => {
      if (!this.ended) this.start(this);
    });
    return {
      dispose: () => {
        if (this.ended) return;
        this.ended = true;
        this.subscriber = null;
        this.stopped(this);
      },
    };
  }

  push(item: T): void {
    if (!this.ended) this.subscriber?.next(item);
  }

  complete(): void {
    const subscriber = this.finish();
    subscriber?.complete();
  }

  fail(error: Error): void {
    const subscriber = this.finish();
    subscriber?.error(error);
  }

  private finish(): IStreamSubscriber<T> | null {
    if (this.ended) return null;
    this.ended = true;
    const subscriber = this.subscriber;
    this.subscriber = null;
    this.stopped(this);
    return subscriber;
  }
}
