import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { MEDIA_SCHEME, mediaContentType, parseMediaUrl } from '@runova/studio';
import { SCENE_SCHEME, type SceneResolver, serveScene } from '@runova/studio/node';
import { net, type Protocol } from 'electron';
import { studioService } from './index';

/**
 * `studio-scene://`, the scheme Studio's scene pages load from: in the editor's preview iframes and
 * in the hidden windows that check and capture scenes. The answers, CSP included, come from the
 * package's scene server; this only hands Electron's requests to it.
 */

/** Registered before the app is ready, in main/index.ts, with the app's other schemes. */
export const STUDIO_SCHEME_PRIVILEGES = {
  scheme: SCENE_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
};

/**
 * `studio-media://`, the editor's way to an imported file and its preview files. `stream` lets a
 * video play before it has all arrived, and seek.
 */
export const STUDIO_MEDIA_PRIVILEGES = {
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
};

let runtime: Promise<Uint8Array> | null = null;

export const studioSceneResolver: SceneResolver = {
  treeFile: (treeHash, path) => studioService().sceneFile({ treeHash, path }),
  // Read once: the bundle ships with the app and does not change while it runs.
  runtime: () => {
    runtime ??= readFile(studioService().assets.runtimeFile).catch((error: unknown) => {
      runtime = null;
      throw error;
    });
    return runtime;
  },
  asset: (path) => studioService().assets.read(path),
  allowedHosts: (treeHash) => studioService().sceneHosts({ treeHash }),
};

export type MediaFileLookup = (
  address: NonNullable<ReturnType<typeof parseMediaUrl>>,
) => Promise<string | null>;

const lookupMediaFile: MediaFileLookup = (address) => studioService().mediaFile(address);

/**
 * Answers `studio-media:` requests on the default session. The address names a video, a file and
 * a variant; the service says where that file is, for an open video only. The file is fetched with
 * the request's own headers, so a video's range requests reach it and it seeks.
 */
export function handleStudioMedia(
  target: Protocol,
  lookup: MediaFileLookup = lookupMediaFile,
): void {
  target.handle(MEDIA_SCHEME, async (request) => {
    const address = parseMediaUrl(request.url);
    const file = address ? await lookup(address) : null;
    if (!address || !file) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString(), { headers: request.headers });
    const type = mediaContentType(address.variant);
    if (!type) return response;
    const headers = new Headers(response.headers);
    headers.set('Content-Type', type);
    return new Response(response.body, { status: response.status, headers });
  });
}

/** Answers `studio-scene:` requests on a session's protocol (the default one, or a capture one). */
export function handleStudioScenes(
  target: Protocol,
  resolver: SceneResolver = studioSceneResolver,
): void {
  target.handle(SCENE_SCHEME, async (request) => {
    const answer = await serveScene(request.url, resolver);
    return new Response(answer.body as BodyInit, {
      status: answer.status,
      headers: answer.headers,
    });
  });
}
