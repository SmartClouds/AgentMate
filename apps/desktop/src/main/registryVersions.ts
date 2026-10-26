import type { UpdateCheckSource } from '@runova/core';

const UPDATE_CHECK_TIMEOUT_MS = 8000;

/** Latest published version for a registry entry, or null when the lookup fails. */
export async function fetchLatestVersion(source: UpdateCheckSource): Promise<string | null> {
  try {
    if (source.type === 'npm') {
      const res = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(source.package)}/latest`,
        {
          signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
        },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { version?: string };
      return data.version ?? null;
    }
    if (source.type === 'pypi') {
      const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(source.package)}/json`, {
        signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { info?: { version?: string } };
      return data.info?.version ?? null;
    }
    const res = await fetch(`https://api.github.com/repos/${source.package}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    return data.tag_name ? data.tag_name.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

/** Where a notification's "what's new" link should point for a given update source. */
export function releaseUrl(source: UpdateCheckSource): string {
  if (source.type === 'npm') return `https://www.npmjs.com/package/${source.package}`;
  if (source.type === 'pypi') return `https://pypi.org/project/${source.package}/`;
  return `https://github.com/${source.package}/releases/latest`;
}

/** Compares dot/dash-separated numeric version segments; positive when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(/[.-]/).map((part) => parseInt(part, 10));
  const partsB = b.split(/[.-]/).map((part) => parseInt(part, 10));
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const na = partsA[i] || 0;
    const nb = partsB[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}
