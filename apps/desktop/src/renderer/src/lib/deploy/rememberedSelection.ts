import { isCloudflare, type ParamReader } from './railSelection';

/**
 * What the Deploy page had open, kept so that coming back to a bare `/deploy` (the sidebar link)
 * opens it again rather than the first server's Overview. An address that names a server, a site
 * or the Cloudflare page always wins, and one-shot params (a Cloudflare account to show, a site to
 * add, a fix to offer) are not kept.
 */

/** The params that say what is open: the selection, its section and what is open inside it. */
const KEPT = [
  'server',
  'site',
  'files',
  'cloudflare',
  'zone',
  'view',
  'tab',
  'app',
  'new',
  'install',
  'registries',
  'source',
  'target',
] as const;

const SELECTION = ['server', 'site', 'files', 'cloudflare'] as const;

function named(params: ParamReader): boolean {
  return SELECTION.some((name) => params.get(name) !== null);
}

/** The part of the address worth remembering, or null when nothing is selected. */
export function rememberable(params: URLSearchParams): string | null {
  if (!named(params)) return null;
  const kept = new URLSearchParams();
  for (const [name, value] of params) {
    if ((KEPT as readonly string[]).includes(name)) kept.append(name, value);
  }
  return kept.toString();
}

/**
 * The address to open in place of one that names nothing, or null to leave it. An older
 * `?dialog=cloudflare` link names the Cloudflare page, so it is left alone too.
 */
export function restoreTarget(
  params: URLSearchParams,
  remembered: string | null,
): URLSearchParams | null {
  if (!remembered || named(params) || isCloudflare(params)) return null;
  const kept = rememberable(new URLSearchParams(remembered));
  return kept ? new URLSearchParams(kept) : null;
}
