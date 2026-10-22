import type { CatalogImageSource, PinnedImage } from './types.js';

/**
 * Every image the catalog runs, pinned by tag and by the digest of its multi-platform index.
 * Each digest was read from the registry with `docker buildx imagetools inspect` on the date in
 * CATALOG_RESOLVED_AT, and each index was checked to carry linux/amd64 and linux/arm64 images. Only
 * Docker Official Images and images from the vendor's own namespace are listed.
 *
 * To move a pin, inspect the new tag and replace both the tag and the digest. Installed apps keep
 * their old digest until someone applies the update (updates.ts).
 */

export const CATALOG_RESOLVED_AT = '2026-10-01';

const PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;

function pin(
  repository: string,
  tag: string,
  digest: `sha256:${string}`,
  source: CatalogImageSource,
  publisher: string,
  resolvedAt = CATALOG_RESOLVED_AT,
): PinnedImage {
  return {
    repository,
    tag,
    digest,
    platforms: PLATFORMS,
    source,
    publisher,
    resolvedAt,
  };
}

const official = (name: string, tag: string, digest: `sha256:${string}`) =>
  pin(`docker.io/library/${name}`, tag, digest, 'docker-official', 'Docker Official Images');

export const CATALOG_IMAGES = {
  mysql97: official(
    'mysql',
    '9.7.2',
    'sha256:e2bde46db6563855d7177adb5f0b57b9dc663f5a20927a90f4259d3312068497',
  ),
  mysql84: official(
    'mysql',
    '8.4.11',
    'sha256:6ea90827b1100f8f2ae306a539f86d2c264a26ed435a2a9f75551dd5c3aeb242',
  ),
  mariadb123: official(
    'mariadb',
    '12.3.3',
    'sha256:805c8e104bd563d5bfa24fadd3f31cd419ea859cb5277f32b5dbf2db714f9ed1',
  ),
  mariadb114: official(
    'mariadb',
    '11.4.13',
    'sha256:70cc072b29b4a89ae07abb2d4da2c64678a7f2dfe092751bb51c87d67dc1338b',
  ),
  postgres18: official(
    'postgres',
    '18.6',
    'sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722',
  ),
  postgres17: official(
    'postgres',
    '17.11',
    'sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f',
  ),
  redis810: official(
    'redis',
    '8.10.2',
    'sha256:6f81e8915c60b065a524e6967e0ad1c639ba6efa84d669f823683ea04d9150ee',
  ),
  mongo90: official(
    'mongo',
    '9.0.2',
    'sha256:c73153413b453d7d31199be36e101ab51195a4e6cff7bee8a2aa52a9769e4e11',
  ),
  mongo80: official(
    'mongo',
    '8.0.32',
    'sha256:4968f22d0c6c10ef29952f3e807f62872ba22b3312f25803564fbfc08255efc2',
  ),
  wordpress71: official(
    'wordpress',
    '7.1.2-php8.3-apache',
    'sha256:4abf7a450ee477dde967584f8174d7e03221d224c4971a0c38d84e7254426e64',
  ),
  ghost6: official(
    'ghost',
    '6.67.0',
    'sha256:428ce627d581017a534d756eae5e8fa973052dd8ec5f5a0c6cd6a83ab85e94ca',
  ),
  adminer6: official(
    'adminer',
    '6.1.1-standalone',
    'sha256:74f29c416e148b98305e84446a18db7cd2c1038264dec464359d36774ef080ce',
  ),
  phpmyadmin52: official(
    'phpmyadmin',
    '5.2.3-apache',
    'sha256:e1d42a6985a9622e1e2461d31d2cea82fb069ee05194dbe2a6c758f86c9ef6b8',
  ),
  nextcloud35: official(
    'nextcloud',
    '35.0.1-apache',
    'sha256:b1ae671e9815401b0e837b19b9c778e89887721d67f0c8f9d34aa1d27a9a208f',
  ),
  nextcloud34: official(
    'nextcloud',
    '34.0.4-apache',
    'sha256:37b109885aa3cba3e056362a899556a625c986f2c17cd2c0cc157d21c789f53b',
  ),
  rabbitmq43: official(
    'rabbitmq',
    '4.3.6-management',
    'sha256:751bf4eeaa6965c0cdee73e1282ec62ac010191b168a18beda8b3e903cbe9769',
  ),
  ollama: pin(
    'docker.io/ollama/ollama',
    '0.35.0',
    'sha256:2a6e883b917fc543389599dae79918f5cac9e1438890506982f44aa4f5625d01',
    'vendor',
    'Ollama',
  ),
  openWebUi: pin(
    'ghcr.io/open-webui/open-webui',
    'v0.11.4',
    'sha256:9591b13f13843c7721c2b8eaf7382846c81b3ffe126526d1888d1fed50c6a33f',
    'vendor',
    'Open WebUI',
  ),
  n8n: pin(
    'docker.io/n8nio/n8n',
    '2.41.4',
    'sha256:3cd1d3a03f5e059a0757d8c95823ff09ef61d3b6bf7fcb4ac3ac5fd5303b6c6d',
    'vendor',
    'n8n',
  ),
  uptimeKuma: pin(
    'docker.io/louislam/uptime-kuma',
    '2.5.5-rootless',
    'sha256:c4e17ce033deb811aff8a61a5f8f736f35b1bd937458ddeec46c59ca190f0e03',
    'vendor',
    'Uptime Kuma',
  ),
  gitea: pin(
    'docker.io/gitea/gitea',
    '28.0.0-rootless',
    'sha256:c168e7ccb767164793a67e1e874639488260795567337452b06292d1515bea12',
    'vendor',
    'Gitea',
  ),
  grafana: pin(
    'docker.io/grafana/grafana',
    '13.2.3',
    'sha256:b28bae15e219c998fb0e0424ed724930cc61b1f61fb404d47c862f9a23f9e572',
    'vendor',
    'Grafana Labs',
  ),
  prometheus: pin(
    'docker.io/prom/prometheus',
    'v3.15.0',
    'sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e',
    'vendor',
    'Prometheus',
  ),
  meilisearch: pin(
    'docker.io/getmeili/meilisearch',
    'v1.54.2',
    'sha256:1c9dc9b037162d59224a4fc8b1fadd96e343213acf7c828e5d380e28407443fb',
    'vendor',
    'Meilisearch',
  ),
  // Added after the rest, so it carries its own resolve date until the next refresh.
  kafka43: pin(
    'docker.io/apache/kafka',
    '4.3.2',
    'sha256:852a0d49fc4e656b022e7f23785411802c9a088c78a7c5e39f33969de9c227a7',
    'vendor',
    'Apache Software Foundation',
    '2026-10-22',
  ),
} as const satisfies Record<string, PinnedImage>;
