import type { DockerImage } from '@shared/apiTypes';
import { describe, expect, it } from 'vitest';
import {
  filterImages,
  hubReference,
  imageLabel,
  localReferences,
  shortImageId,
  splitReference,
  totalBytes,
  unusedImages,
} from './images';

/** The Images view's sorting out of what docker reported, kept apart from the markup. */

function image(overrides: Partial<DockerImage> = {}): DockerImage {
  return {
    id: `sha256:${'a'.repeat(64)}`,
    tags: ['nginx:1.27'],
    dangling: false,
    createdAt: null,
    createdSince: '5 months ago',
    sizeBytes: 100,
    containers: 0,
    ...overrides,
  };
}

const nginx = image({ id: 'sha256:aaaaaaaaaaaa1111', tags: ['nginx:1.27'], containers: 2 });
const node = image({ id: 'sha256:bbbbbbbbbbbb2222', tags: ['node:22'], sizeBytes: 300 });
const dangling = image({ id: 'sha256:cccccccccccc3333', tags: [], dangling: true, sizeBytes: 50 });

describe('shortImageId', () => {
  it('is the first twelve characters after sha256:, like docker prints', () => {
    expect(shortImageId(`sha256:${'0123456789ab'}cdef`)).toBe('0123456789ab');
    expect(shortImageId('0123456789abcdef')).toBe('0123456789ab');
  });
});

describe('imageLabel', () => {
  it('is the first tag, or the short id for an image with none', () => {
    expect(imageLabel(nginx)).toBe('nginx:1.27');
    expect(imageLabel(dangling)).toBe('cccccccccccc');
  });
});

describe('splitReference', () => {
  it('splits the tag off at the last colon of the last path part', () => {
    expect(splitReference('nginx:1.27')).toEqual({ repository: 'nginx', tag: '1.27' });
    // The port belongs to the registry, not the tag.
    expect(splitReference('localhost:5000/team/app:2')).toEqual({
      repository: 'localhost:5000/team/app',
      tag: '2',
    });
    expect(splitReference('localhost:5000/app')).toEqual({
      repository: 'localhost:5000/app',
      tag: null,
    });
  });
});

describe('filterImages', () => {
  const all = [nginx, node, dangling];

  it('narrows to the images containers use, or those none do', () => {
    expect(filterImages(all, 'inUse', '')).toEqual([nginx]);
    expect(filterImages(all, 'unused', '')).toEqual([node, dangling]);
    expect(filterImages(all, 'all', '')).toEqual(all);
  });

  it('matches the search against tags and the short id, ignoring case', () => {
    expect(filterImages(all, 'all', 'NODE')).toEqual([node]);
    expect(filterImages(all, 'all', 'cccccc')).toEqual([dangling]);
    expect(filterImages(all, 'unused', 'nginx')).toEqual([]);
  });
});

describe('unusedImages and totalBytes', () => {
  it('lists what no container uses and adds up the sizes it knows', () => {
    expect(unusedImages([nginx, node, dangling])).toEqual([node, dangling]);
    expect(totalBytes([node, dangling, image({ sizeBytes: null })])).toBe(350);
  });
});

describe('Docker Hub references', () => {
  it('spells a Hub tag the way docker shows it locally', () => {
    expect(hubReference('hubber', 'api', '1.4')).toBe('hubber/api:1.4');
    expect(hubReference('library', 'nginx', '1.27')).toBe('nginx:1.27');
  });

  it("collects this machine's tags with Docker Hub's optional prefixes dropped", () => {
    const local = localReferences([
      image({ tags: ['docker.io/hubber/api:1.4', 'hubber/api:latest'] }),
      image({ tags: ['docker.io/library/nginx:1.27'] }),
      image({ tags: ['ghcr.io/org/app:1'] }),
    ]);

    expect(local.has('hubber/api:1.4')).toBe(true);
    expect(local.has('hubber/api:latest')).toBe(true);
    expect(local.has('nginx:1.27')).toBe(true);
    expect(local.has('ghcr.io/org/app:1')).toBe(true);
  });
});
