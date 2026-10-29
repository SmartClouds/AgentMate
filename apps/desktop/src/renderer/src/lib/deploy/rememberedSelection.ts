import type { ParamReader } from './railSelection';

/**
 * What the Deploy page had open, kept so that coming back to a bare `/deploy` (the sidebar link)
 * opens it again rather than the first server's Overview. An address that names a server or a
 * site always wins, and one-shot params (a dialog, a site to add, a fix to offer) are not kept.
 */

/** The params that say what is open: the selection, its section and what is open inside it. */
const KEPT = [
  'server',
  'site',
  'files',
  'view',
  'tab',
  'app',
  'new',
  'install',
  'registries',
  'source',
  'target',
] as const;

const SELECTION = ['server', 'site', 'files'] as const;

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
 * The address to open in place of one that names nothing, or null to leave it. A Cloudflare
 * dialog the address asks for stays open over what comes back.
 */
export function restoreTarget(
  params: URLSearchParams,
  remembered: string | null,
): URLSearchParams | null {
  if (!remembered || named(params)) return null;
  const kept = rememberable(new URLSearchParams(remembered));
  if (!kept) return null;
  const target = new URLSearchParams(kept);
  const dialog = params.get('dialog');
  if (dialog !== null) target.set('dialog', dialog);
  return target;
}
