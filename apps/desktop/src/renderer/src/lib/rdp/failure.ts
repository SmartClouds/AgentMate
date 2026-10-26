import type { RdpFailureInfo, RdpProxyErrorCode } from '@shared/apiTypes';

/**
 * What the Remote Desktop screens say when a connection can't be made. A failure is a heading,
 * one plain sentence, a few things to try, and, kept apart, the library's own reason for anyone
 * who wants it. Source locations, error numbers and stack text never go in the first three.
 *
 * Kept free of the RDP engine so the main window can use it too.
 */

/** The proxy's codes, plus the ones that come from the engine rather than the network. */
export type RdpFailureCode =
  | RdpProxyErrorCode
  | 'sign-in'
  | 'access-denied'
  | 'security-settings'
  | 'engine';

export interface RdpFailure {
  code: RdpFailureCode;
  title: string;
  message: string;
  /** Things to try, most likely first. */
  hints: string[];
  /** The technical reason, shown collapsed. Safe to copy into a bug report. */
  detail?: string;
}

const ADVICE: Record<RdpFailureCode, { title: string; hints: string[] }> = {
  'host-not-found': {
    title: "Can't find the server",
    hints: [
      "Check the computer name or IP address in this server's settings.",
      'Make sure this computer is online.',
    ],
  },
  refused: {
    title: 'The server refused the connection',
    hints: [
      'Check that Remote Desktop is turned on for the server.',
      'Check the port. Remote Desktop uses 3389 unless it was changed.',
      "Check that the server's firewall allows Remote Desktop.",
    ],
  },
  timeout: {
    title: "The server didn't answer",
    hints: [
      'Check that the server is on and connected to the network.',
      'A firewall may be dropping the connection. Remote Desktop uses port 3389 unless it was changed.',
      'If the server was just restarted or reinstalled, give it a minute to start.',
    ],
  },
  unreachable: {
    title: "Can't reach the server",
    hints: ['Check the address and your network or VPN connection.'],
  },
  closed: {
    title: 'The server closed the connection',
    hints: [
      'The server may be restarting. Wait a moment and reconnect.',
      'Check that Remote Desktop is turned on and allows connections.',
    ],
  },
  'not-rdp': {
    title: "That doesn't look like a Remote Desktop server",
    hints: ["Check the port in this server's settings."],
  },
  'tls-failed': {
    title: "Couldn't set up a secure connection",
    hints: [
      "The server's security settings may not match what Runova supports. Try again in a moment.",
      'If the server was just reinstalled, restart Remote Desktop Services on it.',
    ],
  },
  'tls-key-usage': {
    title: "The server's certificate can't be used",
    hints: [
      'Windows made this certificate for Remote Desktop, and it only allows an older kind of encryption that the server then turned down.',
      'On the server, turn the RSA cipher suites back on in its TLS settings, or give Remote Desktop a certificate that allows digital signatures.',
    ],
  },
  'certificate-changed': {
    title: "The server's certificate changed",
    hints: [
      'This is expected after the server was reinstalled or its certificate was renewed.',
      "If neither happened, don't trust it.",
    ],
  },
  'proxy-failed': {
    title: "Couldn't connect through the proxy",
    hints: [
      'Check the proxy in Settings, under Network. Test connection there shows whether it works.',
      'Many HTTP proxies only allow port 443, and Remote Desktop uses 3389. A SOCKS5 proxy usually allows it.',
      "To skip the proxy for this server, add its address to the proxy's Skip the proxy for list.",
    ],
  },
  other: {
    title: "Couldn't connect",
    hints: ['Check the address and port, then try again.'],
  },
  'sign-in': {
    title: 'Sign-in failed',
    hints: [
      'Edit this server and check the username, password and domain.',
      'For a domain account, enter the username as DOMAIN\\user.',
    ],
  },
  'access-denied': {
    title: "This account can't sign in",
    hints: ['On the server, add the account to the Remote Desktop Users group.'],
  },
  'security-settings': {
    title: "Security settings don't match",
    hints: [
      'Edit this server and switch Network Level Authentication (under Display and sharing), then try again.',
    ],
  },
  engine: { title: "Couldn't connect", hints: [] },
};

/** The failure to show for something the proxy reported. */
export function describeProxyFailure(failure: RdpFailureInfo): RdpFailure {
  const advice = ADVICE[failure.code] ?? ADVICE.other;
  return {
    code: failure.code,
    title: advice.title,
    message: failure.message,
    hints: advice.hints,
    detail: failure.detail,
  };
}

/** A failure with the heading and hints for `code` from the table, around the given sentence. */
export function describeFailure(
  code: RdpFailureCode,
  message: string,
  extra: { detail?: string; hints?: string[] } = {},
): RdpFailure {
  const advice = ADVICE[code];
  return {
    code,
    title: advice.title,
    message,
    hints: extra.hints ?? advice.hints,
    detail: extra.detail,
  };
}
