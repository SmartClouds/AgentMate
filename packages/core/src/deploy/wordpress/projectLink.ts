import type {
  ProjectWordPressItem,
  ProjectWordPressItemKind,
  ProjectWordPressLink,
} from '../../types/index.js';
import { normalizeWpIgnore } from './ignoreList.js';
import { isValidWpSlug, wpItemKey } from './pathPolicy.js';

const KINDS: ReadonlySet<string> = new Set<ProjectWordPressItemKind>([
  'theme',
  'plugin',
  'mu-plugin',
]);
const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * A project's WordPress link as read from disk or a renderer call: undefined unless it has a
 * plausible site id and at least one valid item. Bad items are dropped and duplicates folded.
 */
export function normalizeProjectWordPressLink(value: unknown): ProjectWordPressLink | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as { siteId?: unknown; items?: unknown; linkedAt?: unknown; ignore?: unknown };
  if (typeof raw.siteId !== 'string' || !SITE_ID.test(raw.siteId)) return undefined;
  if (!Array.isArray(raw.items)) return undefined;
  const seen = new Set<string>();
  const items: ProjectWordPressItem[] = [];
  for (const entry of raw.items) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { kind, slug } = entry as { kind?: unknown; slug?: unknown };
    if (typeof kind !== 'string' || !KINDS.has(kind)) continue;
    if (typeof slug !== 'string' || !isValidWpSlug(slug)) continue;
    const item = { kind: kind as ProjectWordPressItemKind, slug };
    const key = wpItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  if (items.length === 0) return undefined;
  const linkedAt =
    typeof raw.linkedAt === 'string' && !Number.isNaN(Date.parse(raw.linkedAt))
      ? raw.linkedAt
      : new Date(0).toISOString();
  const ignore = normalizeWpIgnore(raw.ignore, items);
  return { siteId: raw.siteId, items, linkedAt, ...(ignore ? { ignore } : {}) };
}
