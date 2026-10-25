import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package's own files that scenes use: the fonts and their stylesheet, each style's reference
 * scene, and the runtime bundle. They sit in `assets/` and `dist/bundle/` under the package root.
 * Where that root is depends on the host: the desktop app bundles this code into its main process
 * and ships the files as resources, so it says where they are; tests and an unbundled host use
 * the package folder itself.
 */

/** The package folder, as seen from this file in `src/node/scenes` or `dist/node/scenes`. */
export const DEFAULT_STUDIO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface StudioAssets {
  root: string;
  runtimeFile: string;
  /** Reads an asset by its path inside `assets/`; null when it is not there. */
  read(path: string): Promise<Uint8Array | null>;
  /** The built-in caption page's files (`assets/captions/`). */
  captionPage(): Promise<{ path: string; content: Uint8Array }[]>;
  /** The files of a style's reference scene (`assets/styles/<id>/`). */
  styleReference(styleId: string): Promise<{ path: string; content: Uint8Array }[]>;
}

export function studioAssets(root: string = DEFAULT_STUDIO_ROOT): StudioAssets {
  const assetsDir = resolve(root, 'assets');
  return {
    root,
    runtimeFile: join(root, 'dist', 'bundle', 'studio-runtime.js'),
    async read(path) {
      const full = resolve(assetsDir, path);
      if (!full.startsWith(assetsDir + sep)) return null;
      try {
        return await readFile(full);
      } catch {
        return null;
      }
    },
    async captionPage() {
      const dir = join(assetsDir, 'captions');
      const names = (await readdir(dir)).sort();
      return Promise.all(
        names.map(async (path) => ({ path, content: await readFile(join(dir, path)) })),
      );
    },
    async styleReference(styleId) {
      if (!/^[a-z0-9-]+$/.test(styleId)) throw new Error('That is not a style.');
      const dir = join(assetsDir, 'styles', styleId);
      const names = (await readdir(dir)).sort();
      return Promise.all(
        names.map(async (path) => ({ path, content: await readFile(join(dir, path)) })),
      );
    },
  };
}

const defaults = studioAssets();

/** The runtime bundle in the package folder. */
export const RUNTIME_FILE = defaults.runtimeFile;
export const readStudioAsset = defaults.read;
export const readStyleReference = defaults.styleReference;
