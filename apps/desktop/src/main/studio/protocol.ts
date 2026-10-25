import { readFile } from 'node:fs/promises';
import { SCENE_SCHEME, type SceneResolver, serveScene } from '@agentmat/studio/node';
import type { Protocol } from 'electron';
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
