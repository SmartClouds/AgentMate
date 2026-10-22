import { adminer } from './templates/adminer.js';
import { ghost } from './templates/ghost.js';
import { gitea } from './templates/gitea.js';
import { grafana } from './templates/grafana.js';
import { kafka } from './templates/kafka.js';
import { mariadb } from './templates/mariadb.js';
import { meilisearch } from './templates/meilisearch.js';
import { mongodb } from './templates/mongodb.js';
import { mysql } from './templates/mysql.js';
import { n8n } from './templates/n8n.js';
import { nextcloud } from './templates/nextcloud.js';
import { ollama } from './templates/ollama.js';
import { phpmyadmin } from './templates/phpmyadmin.js';
import { postgres } from './templates/postgres.js';
import { prometheus } from './templates/prometheus.js';
import { rabbitmq } from './templates/rabbitmq.js';
import { redis } from './templates/redis.js';
import { uptimeKuma } from './templates/uptimeKuma.js';
import { wordpress } from './templates/wordpress.js';
import type { AnyCatalogTemplate } from './types.js';

/**
 * The App Store catalog. MinIO was planned too, but its public images are gone: as of 2026-10-01
 * docker.io/minio/minio and quay.io/minio/minio both refuse anonymous pulls, and the catalog only
 * takes images from official or vendor sources.
 */

export * from './images.js';
export * from './installed.js';
export * from './render.js';
export * from './secrets.js';
export type * from './types.js';
export * from './updates.js';

export const CATALOG_TEMPLATES: readonly AnyCatalogTemplate[] = [
  mysql,
  mariadb,
  postgres,
  redis,
  mongodb,
  wordpress,
  ghost,
  ollama,
  n8n,
  uptimeKuma,
  adminer,
  phpmyadmin,
  gitea,
  grafana,
  prometheus,
  nextcloud,
  meilisearch,
  rabbitmq,
  kafka,
];

export function findCatalogTemplate(id: string): AnyCatalogTemplate | null {
  return CATALOG_TEMPLATES.find((template) => template.id === id) ?? null;
}
