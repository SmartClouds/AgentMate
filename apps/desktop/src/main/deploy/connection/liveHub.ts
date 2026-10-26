import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { coreHub, createCoreHubConnection } from './coreHub';
import type { CoreTransport, CoreTransportKind } from './transport';

/**
 * One lasting hub connection, as a server's link keeps it (see live/coreLink.ts). SignalR does not
 * reconnect it: the link opens a new one, through a new SSH connection when that is what died.
 * Its token is fixed for its life, because the core closes a connection once its token runs out.
 */

export interface LiveHubSession {
  hub: ICoreHub;
  /** Settles once the connection has closed, whoever closed it. Never rejects. */
  closed: Promise<void>;
  stop: () => Promise<void>;
  /** When its access token runs out, on the core's clock, or null when that is not known. */
  expiresAt: number | null;
  /** What it rides on, for the connection pill. */
  transport?: CoreTransportKind;
}

/** A hub connection that did not start; `status` is the HTTP answer to a refused upgrade. */
export class HubStartError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'HubStartError';
    this.status = status;
  }
}

export async function startLiveHub(
  transport: CoreTransport,
  token: string,
  expiresAt: number | null,
): Promise<LiveHubSession> {
  let status: number | null = null;
  // SignalR replaces a failed stream with its own generic text; the cause is kept here instead,
  // so a refused tunnel still reads as one.
  let openError: unknown = null;
  const recorded: CoreTransport = {
    kind: transport.kind,
    openStream: () =>
      transport.openStream().catch((error: unknown) => {
        openError = error;
        throw error;
      }),
  };
  const connection = createCoreHubConnection(recorded, () => token, undefined, {
    reconnect: false,
    onUpgradeStatus: (refused) => {
      status = refused;
    },
  });
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  connection.onclose(() => markClosed());
  try {
    await connection.start();
  } catch (error) {
    if (openError) throw openError;
    throw new HubStartError(error instanceof Error ? error.message : String(error), status);
  }
  return {
    hub: coreHub(connection),
    closed,
    stop: () => connection.stop(),
    expiresAt,
    transport: transport.kind,
  };
}
