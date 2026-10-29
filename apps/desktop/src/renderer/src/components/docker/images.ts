import type { DockerImage } from '@shared/apiTypes';

/** The Images view's filters, in the order the toolbar shows them. */
export type ImageFilter = 'all' | 'inUse' | 'unused';

/** The first twelve characters of the id, the way `docker image ls` prints it. */
export function shortImageId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

export function imageLabel(image: DockerImage): string {
  return image.tags[0] ?? shortImageId(image.id);
}

/** "host:5000/team/app:2" into the repository and tag. A colon before the last "/" is a port. */
export function splitReference(ref: string): { repository: string; tag: string | null } {
  const colon = ref.lastIndexOf(':');
  if (colon === -1 || colon < ref.lastIndexOf('/')) return { repository: ref, tag: null };
  return { repository: ref.slice(0, colon), tag: ref.slice(colon + 1) };
}

export function filterImages(
  images: DockerImage[],
  filter: ImageFilter,
  query: string,
): DockerImage[] {
  const q = query.trim().toLowerCase();
  return images.filter((image) => {
    if (filter === 'inUse' && image.containers === 0) return false;
    if (filter === 'unused' && image.containers > 0) return false;
    if (!q) return true;
    return (
      shortImageId(image.id).includes(q) || image.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  });
}

export function unusedImages(images: DockerImage[]): DockerImage[] {
  return images.filter((image) => image.containers === 0);
}

/** The sizes added up. Shared layers are counted once per image, so this is an upper bound. */
export function totalBytes(images: DockerImage[]): number {
  return images.reduce((sum, image) => sum + (image.sizeBytes ?? 0), 0);
}

/** A Docker Hub tag as docker names it locally: official images drop their "library/". */
export function hubReference(namespace: string, name: string, tag: string): string {
  return `${namespace === 'library' ? name : `${namespace}/${name}`}:${tag}`;
}

/** Every tag on this machine, Docker Hub's optional "docker.io/" and "library/" dropped. */
export function localReferences(images: DockerImage[]): Set<string> {
  const references = new Set<string>();
  for (const image of images) {
    for (const tag of image.tags) {
      references.add(tag.replace(/^docker\.io\//, '').replace(/^library\//, ''));
    }
  }
  return references;
}
