import {
  type AnyCatalogTemplate,
  type CatalogCategory,
  type CatalogUpdateCheck,
  type CatalogVersion,
  type PinnedImage,
  validateStackName,
} from '@runova/core';

/** Words and small decisions the App Store screens share. */

export const CATEGORY_LABEL: Record<CatalogCategory, string> = {
  database: 'Databases',
  website: 'Websites',
  ai: 'AI',
  automation: 'Automation',
  monitoring: 'Monitoring',
  storage: 'Storage',
  developer: 'Developer tools',
  search: 'Search',
  messaging: 'Messaging',
};

/** The order categories are listed in. */
export const CATEGORY_ORDER: readonly CatalogCategory[] = [
  'database',
  'website',
  'ai',
  'automation',
  'monitoring',
  'developer',
  'search',
  'messaging',
  'storage',
];

/** Who stands behind an image, as the badge says it. */
export function publisherText(image: PinnedImage): string {
  return image.source === 'docker-official'
    ? 'Docker Official Image'
    : `Verified publisher: ${image.publisher}`;
}

/** The start of a digest, enough to tell two apart at a glance. */
export function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, 12);
}

/** Every image a version runs, once each (two roles can share an image). */
export function versionImages(version: CatalogVersion): PinnedImage[] {
  const seen = new Map<string, PinnedImage>();
  for (const image of Object.values(version.images)) {
    seen.set(`${image.repository}@${image.digest}`, image);
  }
  return [...seen.values()];
}

/** Whether every image of the version comes from Docker's own official program. */
export function allOfficial(version: CatalogVersion): boolean {
  return Object.values(version.images).every((image) => image.source === 'docker-official');
}

export function memoryText(megabytes: number): string {
  return megabytes >= 1024
    ? `about ${Number((megabytes / 1024).toFixed(1))} GB of memory`
    : `about ${megabytes} MB of memory`;
}

/** The template's id as an app name, with a number after it when that name is taken. */
export function suggestStoreAppName(
  template: AnyCatalogTemplate,
  taken: readonly string[],
): string {
  const base = validateStackName(template.id).ok ? template.id : 'app';
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) {
    const name = `${base}-${n}`;
    if (!taken.includes(name)) return name;
  }
  return `${base}-${Date.now() % 10_000}`;
}

export type UpdateOffer =
  | { kind: 'none' }
  | { kind: 'digest'; version: string; text: string; detail: string }
  | { kind: 'line'; version: CatalogVersion; text: string };

/**
 * What the post-install card offers. Newer images for the same line come first, since they are
 * fixes; a newer line (PostgreSQL 17 to 18) is offered on its own, as it can need a migration.
 */
export function updateOffers(check: CatalogUpdateCheck, current: string): UpdateOffer[] {
  const offers: UpdateOffer[] = [];
  if (check.status === 'update') {
    const tags = check.changes.map((change) =>
      change.from && change.from.tag !== change.to.tag
        ? `${change.from.tag} to ${change.to.tag}`
        : `${change.to.tag} (rebuilt)`,
    );
    offers.push({
      kind: 'digest',
      version: check.version,
      text: `Newer images for ${current}: ${tags.join(', ')}.`,
      detail: check.changes
        .map(
          (change) =>
            `${change.role}: ${change.from ? shortDigest(change.from.digest) : 'new'} to ${shortDigest(change.to.digest)}`,
        )
        .join('; '),
    });
  }
  const [newest] = check.newerVersions;
  if (newest) {
    offers.push({ kind: 'line', version: newest, text: `${newest.label} is available.` });
  }
  return offers;
}
