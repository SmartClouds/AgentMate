import { CATALOG_TEMPLATES, checkCatalogUpdate, findCatalogTemplate } from '@runova/core';
import { describe, expect, it } from 'vitest';
import {
  allOfficial,
  CATEGORY_ORDER,
  memoryText,
  publisherText,
  shortDigest,
  suggestStoreAppName,
  updateOffers,
  versionImages,
} from './format';

const postgres = findCatalogTemplate('postgres');
const grafana = findCatalogTemplate('grafana');
if (!postgres || !grafana) throw new Error('catalog changed');

describe('App Store words', () => {
  it('lists every category the catalog uses', () => {
    for (const template of CATALOG_TEMPLATES) {
      expect(CATEGORY_ORDER).toContain(template.category);
    }
  });

  it('names who publishes an image', () => {
    const [official] = versionImages(postgres.versions[0]);
    expect(publisherText(official)).toBe('Docker Official Image');
    expect(allOfficial(postgres.versions[0])).toBe(true);
    const [vendor] = versionImages(grafana.versions[0]);
    expect(publisherText(vendor)).toMatch(/^Verified publisher: /);
    expect(allOfficial(grafana.versions[0])).toBe(false);
  });

  it('shortens digests and memory', () => {
    expect(shortDigest(`sha256:${'ab'.repeat(32)}`)).toBe('abababababab');
    expect(memoryText(256)).toBe('about 256 MB of memory');
    expect(memoryText(2048)).toBe('about 2 GB of memory');
  });

  it('suggests a free name', () => {
    expect(suggestStoreAppName(postgres, [])).toBe('postgres');
    expect(suggestStoreAppName(postgres, ['postgres', 'postgres-2'])).toBe('postgres-3');
  });
});

describe('updateOffers', () => {
  const [v18, v17] = postgres.versions;
  const image = v17.images.db;

  it('offers nothing for an app on the newest line and digest', () => {
    const check = checkCatalogUpdate(postgres, {
      version: v18.id,
      images: { db: { tag: v18.images.db.tag, digest: v18.images.db.digest } },
    });
    expect(updateOffers(check, v18.label)).toEqual([]);
  });

  it('offers newer images for the same line, then the newer line', () => {
    const check = checkCatalogUpdate(postgres, {
      version: v17.id,
      images: { db: { tag: '17.0', digest: `sha256:${'0'.repeat(64)}` } },
    });
    const offers = updateOffers(check, v17.label);
    expect(offers[0]).toMatchObject({
      kind: 'digest',
      version: v17.id,
      text: `Newer images for ${v17.label}: 17.0 to ${image.tag}.`,
    });
    expect(offers[1]).toMatchObject({ kind: 'line', text: `${v18.label} is available.` });
  });
});
