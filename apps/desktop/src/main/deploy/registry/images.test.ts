import { describe, expect, it } from 'vitest';
import { registriesOfCompose } from './images';

function compose(...images: string[]): string {
  return `services:\n${images.map((image, index) => `  s${index}:\n    image: "${image}"\n`).join('')}`;
}

describe('registriesOfCompose', () => {
  it('reads the host of every image that is pulled, and skips the built ones', () => {
    const text = `services:
  web:
    image: ghcr.io/acme/web:1.0
  db:
    image: postgres:17
  worker:
    build: ./worker
    image: registry.example.com:5000/acme/worker
`;

    expect(registriesOfCompose(text)).toEqual({
      registries: ['docker.io', 'ghcr.io'],
      unresolved: false,
    });
  });

  it('takes the default of a host variable the .env does not set', () => {
    // As in a compose file that publishes to GHCR but lets a deployment point elsewhere.
    const text = compose(
      '${CURALINK_IMAGE_PREFIX:-ghcr.io/smartclouds/curalink}-web:${CURALINK_VERSION:-latest}',
      '${CURALINK_IMAGE_PREFIX:-ghcr.io/smartclouds/curalink}-api:${CURALINK_VERSION:-latest}',
      'redis:7-alpine',
    );

    expect(registriesOfCompose(text, ['CURALINK_VERSION', 'POSTGRES_PASSWORD'])).toEqual({
      registries: ['docker.io', 'ghcr.io'],
      unresolved: false,
    });
  });

  it('says the host is unknown when the .env sets the variable it comes from', () => {
    const text = compose(
      '${CURALINK_IMAGE_PREFIX:-ghcr.io/smartclouds/curalink}-web:${CURALINK_VERSION:-latest}',
      '${REGISTRY}/acme/api:1.0',
      'redis:7-alpine',
    );

    expect(registriesOfCompose(text, ['CURALINK_IMAGE_PREFIX'])).toEqual({
      registries: ['docker.io'],
      unresolved: true,
    });
    expect(registriesOfCompose(compose('${REGISTRY}/acme/api:1.0'), ['REGISTRY'])).toEqual({
      registries: [],
      unresolved: true,
    });
    expect(registriesOfCompose(compose('${IMAGE}'), ['IMAGE']).unresolved).toBe(true);
  });

  it('knows the host when only the rest of the name comes from the .env', () => {
    const text = compose('ghcr.io/acme/${APP}:${TAG}', '${ORG:-acme}/tool');

    expect(registriesOfCompose(text, ['APP', 'TAG'])).toEqual({
      registries: ['docker.io', 'ghcr.io'],
      unresolved: false,
    });
    // ORG may hold a host of its own ("registry.example.com"), so once the .env sets it, it is unknown.
    expect(registriesOfCompose(text, ['APP', 'TAG', 'ORG'])).toEqual({
      registries: ['ghcr.io'],
      unresolved: true,
    });
  });

  it('leaves out names Compose would refuse anyway', () => {
    const text = compose('${MISSING}/acme/web', '${BROKEN', '$$literal/web');

    expect(registriesOfCompose(text)).toEqual({ registries: ['docker.io'], unresolved: false });
  });
});
