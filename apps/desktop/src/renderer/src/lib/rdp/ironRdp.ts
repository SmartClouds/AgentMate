// Registers the <iron-remote-desktop> custom element as a side effect.
import '@devolutions/iron-remote-desktop';
import type { IronError, UserInteraction } from '@devolutions/iron-remote-desktop';
import {
  Backend,
  displayControl,
  enableCredssp,
  type FileInfo,
  init,
  RdpFileTransferProvider,
} from '@devolutions/iron-remote-desktop-rdp';
import type { RdpProxyErrorPayload } from '@shared/apiTypes';
import { describeFailure, describeProxyFailure, type RdpFailure } from './failure';

/**
 * Thin glue around Devolutions' IronRDP web packages. This module is heavy (the WebAssembly
 * engine ships inline), so only the Remote Desktop session window loads it, lazily.
 */

export type { FileInfo, UserInteraction };
export { displayControl, enableCredssp, RdpFileTransferProvider };

export type RdpScale = 'fit' | 'real';

let engineReady: Promise<void> | null = null;

/** Compiles the WebAssembly engine once per window; every session object needs it first. */
function loadEngine(): Promise<void> {
  engineReady ??= init('warn').catch((error: unknown) => {
    engineReady = null;
    throw error;
  });
  return engineReady;
}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The element fires `ready` before its clipboard support finishes setting up: that step first
 * awaits a clipboard permission query, and a connection started before it completes is built
 * without the clipboard channel, so nothing ever syncs. Queued permission queries resolve in
 * order, so asking the same question after the element has and then yielding once lands after
 * its setup is done.
 */
async function clipboardSetupSettled(): Promise<void> {
  await nextTask();
  try {
    await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
  } catch {
    await navigator.clipboard.read().catch(() => undefined);
  }
  await nextTask();
}

/** The engine's namespace of WebAssembly classes the element builds its session from. */
export type RdpBackend = typeof Backend;

/** The live connection the element drives. The AI task sends input through it directly. */
export type RdpSession = Awaited<ReturnType<InstanceType<RdpBackend['SessionBuilder']>['connect']>>;

/**
 * Returns `backend` with a SessionBuilder that reports the session it connects. `UserInteraction`
 * has no input API, but the element builds its session through `module.SessionBuilder`, so this
 * is where the session can be picked up. The builder is the engine's own object with only
 * `connect` patched, because the WebAssembly classes don't support being subclassed.
 */
export function wrapBackend(
  backend: RdpBackend,
  onSession: (session: RdpSession) => void,
): RdpBackend {
  function SessionBuilder(): InstanceType<RdpBackend['SessionBuilder']> {
    const builder = new backend.SessionBuilder();
    const connect = builder.connect.bind(builder);
    builder.connect = async () => {
      const session = await connect();
      onSession(session);
      return session;
    };
    return builder;
  }
  return {
    ...backend,
    // Called with `new`, a function that returns an object yields that object.
    SessionBuilder: SessionBuilder as unknown as RdpBackend['SessionBuilder'],
  };
}

export interface MountedRemoteDesktop {
  element: HTMLElement;
  ui: UserInteraction;
  /** The backend the element was given, with its session builder wrapped. */
  backend: RdpBackend;
  /** The canvas the element draws the remote screen on, once it has made one. */
  canvas: () => HTMLCanvasElement | null;
}

/** Creates the element and resolves once it hands over its control surface. */
export async function mountRemoteDesktop(
  host: HTMLElement,
  options: { onSession?: (session: RdpSession) => void } = {},
): Promise<MountedRemoteDesktop> {
  await loadEngine();
  const backend = wrapBackend(Backend, (session) => options.onSession?.(session));
  const mounted = await new Promise<MountedRemoteDesktop>((resolve) => {
    const element = document.createElement('iron-remote-desktop') as HTMLElement & {
      module: unknown;
    };
    element.module = backend;
    element.setAttribute('scale', 'fit');
    element.setAttribute('flexcenter', 'true');
    element.setAttribute('verbose', 'false');
    element.style.display = 'block';
    element.style.width = '100%';
    element.style.height = '100%';
    element.addEventListener(
      'ready',
      (event) => {
        const detail = (event as CustomEvent<{ irgUserInteraction: UserInteraction }>).detail;
        resolve({
          element,
          ui: detail.irgUserInteraction,
          backend,
          canvas: () => element.shadowRoot?.querySelector('canvas') ?? null,
        });
      },
      { once: true },
    );
    host.appendChild(element);
  });
  await clipboardSetupSettled();
  return mounted;
}

/** Mirrors `IronErrorKind`, which the package declares as a type only. */
const ErrorKind = {
  WrongPassword: 1,
  LogonFailure: 2,
  AccessDenied: 3,
  RDCleanPath: 4,
  ProxyConnect: 5,
  NegotiationFailure: 6,
} as const;

function isIronError(error: unknown): error is IronError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as IronError).kind === 'function' &&
    typeof (error as IronError).backtrace === 'function'
  );
}

/** What the failure screen shows: a heading, a sentence, things to try, and the engine's own reason. */
export type ConnectFailure = RdpFailure;

/** The `[ConnectionActivation::CapabilitiesExchange @ crates/ironrdp-connector/src/lib.rs:409]` prefix. */
const ENGINE_CONTEXT = /\[\s*([^\]@]*?)\s*(?:@[^\]]*)?\]\s*/g;
const ENGINE_LABEL = /^(?:reason|source|caused by)\s*:\s*/i;

/**
 * Engine text without the Rust source locations and labels, e.g. "unexpected Share Control PDU
 * during capabilities exchange: got Data PDU (expected Server Demand Active PDU)". Plain text
 * comes back unchanged.
 */
export function cleanEngineText(text: string): string {
  for (const line of text.split('\n')) {
    const cleaned = line.replace(ENGINE_CONTEXT, '').trim().replace(ENGINE_LABEL, '').trim();
    if (cleaned) return cleaned;
  }
  return '';
}

/** Stages of the engine's connection sequence, matched against its context and reason. */
const ENGINE_STAGES: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  {
    pattern:
      /CapabilitiesExchange|ConnectionActivation|ConnectionFinalization|Demand Active|Deactivate All/i,
    message:
      'The server stopped partway through setting up the session. It may have restarted or dropped the session. Reconnect, and if it keeps failing, restart Remote Desktop on the server.',
  },
  {
    pattern: /licens/i,
    message:
      "The server's Remote Desktop licensing refused this session. Check the licensing setup on the server.",
  },
  {
    pattern: /credssp|kerberos|ntlm|\bnla\b/i,
    message:
      'Network Level Authentication failed. Check the username, password, and domain, or try switching Network Level Authentication for this server.',
  },
  {
    pattern: /\btls\b|certificate/i,
    message:
      "A secure connection to the server couldn't be set up. Its certificate or TLS settings may not be supported.",
  },
  {
    pattern:
      /websocket|unexpected eof|connection (?:reset|refused|closed|aborted)|timed out|timeout/i,
    message:
      'The connection to the server dropped. Check that the server is reachable and try again.',
  },
];

/** Reasons the server wrote itself, like "The server denied the connection", read fine as they are. */
function isPlainSentence(text: string): boolean {
  return /^[A-Z][a-z]+ [a-z]/.test(text) && !/PDU|::|[_{}]/.test(text);
}

function describeEngineText(text: string): ConnectFailure {
  const reason = cleanEngineText(text);
  const detail = reason || undefined;
  if (reason && isPlainSentence(reason)) {
    return describeFailure('engine', /[.!?]$/.test(reason) ? reason : `${reason}.`);
  }
  const contexts = [...text.matchAll(ENGINE_CONTEXT)].map((match) => match[1]).join(' ');
  const stage = ENGINE_STAGES.find(({ pattern }) => pattern.test(`${contexts} ${reason}`));
  return describeFailure(
    'engine',
    stage?.message ??
      'The connection failed while setting up the remote session. Try reconnecting.',
    { detail },
  );
}

/**
 * What to tell the user about a failed connect. `proxyFailure` is what the local proxy reported,
 * which is more specific than anything the engine can see when the failure was on the network
 * side. The engine's own text names Rust crates and source lines, so it only goes in `detail`.
 */
export function describeConnectError(
  error: unknown,
  proxyFailure: RdpProxyErrorPayload | null,
): ConnectFailure {
  if (!isIronError(error)) {
    if (proxyFailure) return describeProxyFailure(proxyFailure);
    return describeEngineText(error instanceof Error ? error.message : String(error));
  }
  switch (error.kind() as number) {
    case ErrorKind.WrongPassword:
    case ErrorKind.LogonFailure:
      return describeFailure('sign-in', 'The server did not accept the username or password.');
    case ErrorKind.AccessDenied:
      return describeFailure(
        'access-denied',
        'The server refused this account. It may not be allowed to sign in over Remote Desktop.',
      );
    case ErrorKind.NegotiationFailure:
      return describeFailure(
        'security-settings',
        "Runova and the server couldn't agree on security settings.",
      );
    case ErrorKind.RDCleanPath:
    case ErrorKind.ProxyConnect:
      return proxyFailure
        ? describeProxyFailure(proxyFailure)
        : describeFailure('other', 'Could not reach the server.');
    default: {
      if (proxyFailure) return describeProxyFailure(proxyFailure);
      const backtrace = error.backtrace();
      // biome-ignore lint/suspicious/noConsole: keeps the full engine trace for bug reports
      console.warn('[rdp] connection failed:', backtrace);
      return describeEngineText(backtrace);
    }
  }
}

/**
 * A desktop size servers accept: 200 to 8192 pixels each way, with the width a multiple of 4.
 * The display-control channel needs an even width, and xrdp pads odd-aligned widths to 4, which
 * skews every row of the picture if the client asked for anything else.
 */
export function clampDesktopSize(width: number, height: number): { width: number; height: number } {
  const clamp = (value: number): number => Math.min(8192, Math.max(200, Math.floor(value)));
  return { width: clamp(width) & ~3, height: clamp(height) };
}

/**
 * Lets a new clipboard copy replace one the server never pasted. The provider refuses a second
 * upload until the first is fully read, which with a clipboard means "until the user pastes",
 * so a copy that was never pasted would block every later one. The field name is pinned by the
 * exact package version in package.json.
 */
export function forgetUnpastedUpload(provider: RdpFileTransferProvider): void {
  const internal = provider as unknown as { uploadState?: unknown; retainedFiles?: unknown };
  internal.uploadState = undefined;
  internal.retainedFiles = undefined;
}
