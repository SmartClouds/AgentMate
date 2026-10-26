import {
  HttpTransportType,
  type HubConnection,
  HubConnectionBuilder,
  type IHttpConnectionOptions,
  type ILogger,
} from '@microsoft/signalr';
import WebSocket, { type ClientOptions } from 'ws';
import { getHubProxyFactory } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { coreHostFor } from './coreHttp';
import type { CoreTransport } from './transport';

/**
 * The SignalR connection to a server core, over the same transport as REST. WebSockets only,
 * with no negotiate round trip: the core allows nothing else. In Node, SignalR sends the access
 * token as a header, so it never lands in a URL or a log.
 */

const RECONNECT_DELAYS_MS = [0, 2_000, 5_000, 10_000, 30_000];

/** SignalR's own logging goes nowhere by default; failures surface through the connection. */
const quietLogger: ILogger = { log: () => undefined };

/** What `ws` says when the core answers the upgrade with something other than 101. */
const REFUSED_UPGRADE = /^Unexpected server response: (\d{3})$/;

export interface CoreHubOptions {
  /**
   * Whether SignalR reconnects by itself (the default). The app's lasting connections turn it
   * off: their transport rides one SSH connection, which may be the thing that died, so they
   * open a fresh one themselves.
   */
  reconnect?: boolean;
  /**
   * The HTTP status of a refused upgrade. SignalR reports every refusal with the same text, but
   * a 401 (renew the token) and a 503 (the core is starting) call for different answers.
   */
  onUpgradeStatus?: (status: number) => void;
}

export function createCoreHubConnection(
  transport: CoreTransport,
  accessToken: () => string | Promise<string>,
  logger: ILogger = quietLogger,
  hubOptions: CoreHubOptions = {},
): HubConnection {
  // `ws` hands `createConnection` to node:http, which accepts a callback for sockets that are
  // made asynchronously, like a tunnel opened through SSH.
  const createConnection = ((
    _options: unknown,
    callback: (error: Error | null, socket?: unknown) => void,
  ) => {
    transport.openStream().then(
      (stream) => callback(null, stream),
      (error: Error) => callback(error),
    );
    return undefined;
  }) as unknown as ClientOptions['createConnection'];

  const onUpgradeStatus = hubOptions.onUpgradeStatus;
  class TunnelWebSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[], options?: ClientOptions) {
      super(address, protocols, { ...options, createConnection });
      if (onUpgradeStatus) {
        this.on('error', (error: Error) => {
          const status = REFUSED_UPGRADE.exec(error.message)?.[1];
          if (status) onUpgradeStatus(Number(status));
        });
      }
    }
  }

  // SignalR 10 still reads `WebSocket` from these options (see its HttpConnection), but no
  // longer lists it in the public type. The hub test fails if the tunnel class is ever ignored.
  const options: IHttpConnectionOptions & { WebSocket: unknown } = {
    transport: HttpTransportType.WebSockets,
    skipNegotiation: true,
    WebSocket: TunnelWebSocket,
    accessTokenFactory: accessToken,
    logMessageContent: false,
  };

  const builder = new HubConnectionBuilder().withUrl(
    `http://${coreHostFor(transport)}/hubs/core`,
    options,
  );
  if (hubOptions.reconnect !== false) builder.withAutomaticReconnect(RECONNECT_DELAYS_MS);
  return builder.configureLogging(logger).build();
}

/** The typed client generated from the core's `ICoreHub`. */
export function coreHub(connection: HubConnection): ICoreHub {
  return getHubProxyFactory('ICoreHub').createHubProxy(connection);
}
