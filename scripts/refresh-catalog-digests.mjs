#!/usr/bin/env node
// Refreshes the App Store's pinned image digests (E12 T5).
//
// For every image in packages/core/src/deploy/catalog/images.ts it asks the registry, through
// `docker buildx imagetools inspect`, for the digest the pinned tag points at now, and checks that
// the index still carries linux/amd64 and linux/arm64. A digest that moved is replaced in the file
// and CATALOG_RESOLVED_AT becomes today. Tags are never changed here: moving to a newer tag is a
// reviewed edit. Installed apps keep their digest until someone applies the update in the app.
//
//   node scripts/refresh-catalog-digests.mjs          rewrite images.ts
//   node scripts/refresh-catalog-digests.mjs --check  only report, exit 1 when a digest moved
//
// Needs Docker with buildx and network access to the registries. Build @runova/core first
// (pnpm build:packages), since the list of images is read from its build.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES_TS = join(ROOT, 'packages', 'core', 'src', 'deploy', 'catalog', 'images.ts');
const CORE = join(ROOT, 'packages', 'core', 'dist', 'index.js');
const REQUIRED = ['linux/amd64', 'linux/arm64'];
const check = process.argv.includes('--check');

function inspect(reference) {
  const raw = execFileSync(
    'docker',
    ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'],
    { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const manifest = JSON.parse(raw);
  const platforms = (manifest.manifests ?? [])
    .map((entry) => entry.platform)
    .filter(Boolean)
    .map((platform) => `${platform.os}/${platform.architecture}`);
  return { digest: manifest.digest, platforms };
}

const { CATALOG_IMAGES } = await import(pathToFileURL(CORE).href);
let source = readFileSync(IMAGES_TS, 'utf8');
let moved = 0;
let failed = 0;

for (const [name, image] of Object.entries(CATALOG_IMAGES)) {
  const reference = `${image.repository}:${image.tag}`;
  try {
    const now = inspect(reference);
    const missing = REQUIRED.filter((platform) => !now.platforms.includes(platform));
    if (missing.length > 0) {
      failed++;
      console.error(`${name}: ${reference} no longer carries ${missing.join(', ')}.`);
      continue;
    }
    if (now.digest === image.digest) {
      console.log(`${name}: ${reference} unchanged.`);
      continue;
    }
    moved++;
    console.log(`${name}: ${reference} moved from ${image.digest} to ${now.digest}.`);
    if (!source.includes(image.digest)) throw new Error(`${image.digest} is not in images.ts`);
    source = source.replace(image.digest, now.digest);
  } catch (error) {
    failed++;
    const said = (error.stderr?.toString() || error.message).trim().split('\n').at(-1);
    console.error(`${name}: ${reference} could not be read: ${said}`);
  }
}

if (moved > 0 && !check) {
  const today = new Date().toISOString().slice(0, 10);
  source = source.replace(
    /export const CATALOG_RESOLVED_AT = '\d{4}-\d{2}-\d{2}';/,
    `export const CATALOG_RESOLVED_AT = '${today}';`,
  );
  writeFileSync(IMAGES_TS, source);
  console.log(`Wrote ${moved} new digest(s) to images.ts. Run the catalog tests next.`);
}

process.exit(failed > 0 || (check && moved > 0) ? 1 : 0);
