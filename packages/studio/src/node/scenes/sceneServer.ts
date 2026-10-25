import { extname } from 'node:path';
import type { SceneConfig } from '../../runtime/runtime.js';
import { decodeSceneConfig, SCENE_SCHEME } from '../../scenes/url.js';
import { isSafeTreePath } from './codeTree.js';

export { encodeSceneConfig, SCENE_SCHEME, sceneUrl } from '../../scenes/url.js';

/**
 * What `studio-scene://t-<treeHash>/<path>` answers. Each code tree gets its own host, so the
 * page's own origin (and the `'self'` in its CSP) covers exactly that one immutable tree and
 * nothing else. Only files listed in the tree are served, plus the runtime under `/__studio/`;
 * `index.html` gets the scene's config and the runtime put at the top of its head, before any
 * code of the scene runs. The CSP allows no network at all.
 */

export const RUNTIME_PATH = '__studio/runtime.js';
export const FONTS_CSS_PATH = '__studio/fonts.css';
/** Studio's own files a scene may load (the fonts and their stylesheet), by served path. */
export const STUDIO_ASSETS: Record<string, string> = {
  [FONTS_CSS_PATH]: 'fonts/fonts.css',
  '__studio/fonts/Vazirmatn.woff2': 'fonts/Vazirmatn.woff2',
  '__studio/fonts/Inter.woff2': 'fonts/Inter.woff2',
  '__studio/fonts/NotoNaskhArabic.ttf': 'fonts/NotoNaskhArabic.ttf',
};

/** No network, no frames, no forms; the page may only load what its own tree holds. */
export function sceneCsp(allowedHosts: readonly string[] = []): string {
  const hosts = allowedHosts.map((h) => `https://${h}`).join(' ');
  const extra = hosts ? ` ${hosts}` : '';
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${extra}`,
    `style-src 'self' 'unsafe-inline'${extra}`,
    `img-src 'self' data: blob:${extra}`,
    `media-src 'self' blob:${extra}`,
    `font-src 'self' data:${extra}`,
    `connect-src ${hosts || "'none'"}`,
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export interface SceneResolver {
  /** A file of a tree, or null when the tree or the file is not known. */
  treeFile(treeHash: string, path: string): Promise<Uint8Array | null>;
  /** The runtime bundle. */
  runtime(): Promise<Uint8Array>;
  /** One of Studio's own files, by its path in the package's assets folder. */
  asset(path: string): Promise<Uint8Array | null>;
  /** Hosts this tree's video may reach (the project's allowlist); empty by default. */
  allowedHosts?(treeHash: string): Promise<readonly string[]>;
}

export interface SceneResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

/** The config and the runtime, at the very top of the head, so they run before the scene. */
export function injectRuntime(html: string, config: Partial<SceneConfig>): string {
  // `<` is escaped so a value can never close the script element it sits in.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const tags =
    `<script id="studio-config" type="application/json">${json}</script>` +
    `<link rel="stylesheet" href="/${FONTS_CSS_PATH}">` +
    `<script src="/${RUNTIME_PATH}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) + tags + html.slice(head.index + head[0].length)
    );
  return `<!doctype html><head><meta charset="utf-8">${tags}</head>${html}`;
}

const notFound = (): SceneResponse => ({
  status: 404,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  body: 'Not found',
});

export async function serveScene(url: string, resolver: SceneResolver): Promise<SceneResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return notFound();
  }
  const host = /^t-([0-9a-f]{64})$/.exec(parsed.hostname);
  if (parsed.protocol !== `${SCENE_SCHEME}:` || !host) return notFound();
  const treeHash = host[1] as string;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')) || 'index.html';
  } catch {
    return notFound();
  }
  const allowed = (await resolver.allowedHosts?.(treeHash)) ?? [];
  const headers = (type: string): Record<string, string> => ({
    'Content-Type': type,
    'Content-Security-Policy': sceneCsp(allowed),
    // The preview iframe is sandboxed to an opaque origin, so even the page's own files arrive
    // cross-origin. The tree is read-only and carries no credentials.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });

  if (path === RUNTIME_PATH) {
    return {
      status: 200,
      headers: headers(TYPES['.js'] as string),
      body: await resolver.runtime(),
    };
  }
  const asset = STUDIO_ASSETS[path];
  if (asset) {
    const bytes = await resolver.asset(asset);
    if (!bytes) return notFound();
    const type = TYPES[extname(asset).toLowerCase()] ?? 'application/octet-stream';
    return { status: 200, headers: headers(type), body: bytes };
  }
  if (path.startsWith('__studio/') || !isSafeTreePath(path)) return notFound();
  const bytes = await resolver.treeFile(treeHash, path);
  if (!bytes) return notFound();
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  if (path === 'index.html') {
    const config = decodeSceneConfig(parsed.searchParams.get('c'));
    const html = injectRuntime(Buffer.from(bytes).toString('utf8'), config);
    return { status: 200, headers: headers(type), body: html };
  }
  return { status: 200, headers: headers(type), body: bytes };
}
