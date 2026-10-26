/**
 * How Runova reaches the internet. Everything the app sends out (AI
 * providers, skill and package registries, Telegram, update checks, and the
 * CLIs it spawns) goes through whatever is configured here.
 */
export const PROXY_MODES = ['direct', 'system', 'manual'] as const;
export type ProxyMode = (typeof PROXY_MODES)[number];

export const PROXY_PROTOCOLS = ['http', 'https', 'socks5', 'socks4'] as const;
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number];

export interface ProxySettings {
  /**
   * 'direct' talks to the internet straight, 'system' picks up whatever this
   * machine (or its PAC script) is configured with, 'manual' uses the server
   * spelled out below.
   */
  mode: ProxyMode;
  protocol: ProxyProtocol;
  /** Host name or IP of the proxy, without a scheme or port. */
  host: string;
  /** Null while the field is empty; a saved manual proxy always has one. */
  port: number | null;
  /** Blank when the proxy needs no credentials. */
  username: string;
  password: string;
  /**
   * Hosts that skip the proxy. Chromium bypass syntax, so "<local>" covers
   * localhost and friends, and "*.corp.example" covers a whole domain.
   */
  bypassList: string[];
}

/** Loopback and plain host names, the same set Chromium's "<local>" covers. */
export const DEFAULT_PROXY_BYPASS = ['<local>'];

export function defaultProxySettings(): ProxySettings {
  return {
    mode: 'direct',
    protocol: 'http',
    host: '',
    port: null,
    username: '',
    password: '',
    bypassList: [...DEFAULT_PROXY_BYPASS],
  };
}

function normalizePort(value: unknown): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * settings.json is hand-editable and can come from an older build, so the whole
 * block is checked before either process acts on it. A half-written manual
 * entry falls back to 'direct' rather than sending every request at a host that
 * isn't there.
 */
export function normalizeProxySettings(
  value: Partial<ProxySettings> | null | undefined,
): ProxySettings {
  const defaults = defaultProxySettings();
  if (!value || typeof value !== 'object') return defaults;

  const host = normalizeText(value.host);
  const port = normalizePort(value.port);
  const mode = PROXY_MODES.includes(value.mode as ProxyMode) ? (value.mode as ProxyMode) : 'direct';
  const bypassList = Array.isArray(value.bypassList)
    ? [
        ...new Set(
          value.bypassList
            .filter((rule): rule is string => typeof rule === 'string')
            .map((rule) => rule.trim())
            .filter(Boolean),
        ),
      ]
    : [...DEFAULT_PROXY_BYPASS];

  return {
    mode: mode === 'manual' && (!host || port == null) ? 'direct' : mode,
    protocol: PROXY_PROTOCOLS.includes(value.protocol as ProxyProtocol)
      ? (value.protocol as ProxyProtocol)
      : 'http',
    host,
    port,
    username: normalizeText(value.username),
    password: typeof value.password === 'string' ? value.password : '',
    bypassList,
  };
}

/** True when requests should be routed somewhere other than straight out. */
export function isProxyActive(settings: ProxySettings): boolean {
  if (settings.mode === 'system') return true;
  return settings.mode === 'manual' && Boolean(settings.host) && settings.port != null;
}

/**
 * "http://10.0.0.1:8080" for Chromium's proxy rules and for the child
 * processes Runova spawns. Credentials are left out on purpose: Chromium
 * ignores them in a proxy rule and asks through its login event instead.
 */
export function proxyServerUrl(settings: ProxySettings): string | null {
  if (settings.mode !== 'manual' || !settings.host || settings.port == null) return null;
  return `${settings.protocol}://${settings.host}:${settings.port}`;
}

/**
 * Same address, with credentials, for the HTTP_PROXY-style variables the CLIs
 * and git read. Those tools have no way to prompt, so the password has to ride
 * along in the URL.
 */
export function proxyEnvUrl(settings: ProxySettings): string | null {
  const base = proxyServerUrl(settings);
  if (!base) return null;
  if (!settings.username) return base;
  const auth = `${encodeURIComponent(settings.username)}:${encodeURIComponent(settings.password)}`;
  return base.replace('://', `://${auth}@`);
}

/**
 * Chromium wants one string, and the tools that read NO_PROXY want a comma list
 * without Chromium's "<local>" shorthand, so that one is expanded here.
 */
export function proxyBypassRules(settings: ProxySettings): string {
  return settings.bypassList.join(',');
}

export function noProxyEnvValue(settings: ProxySettings): string {
  const expanded = settings.bypassList.flatMap((rule) =>
    rule === '<local>' ? ['localhost', '127.0.0.1', '::1'] : [rule],
  );
  return [...new Set(expanded)].join(',');
}
