import type { SceneConfig } from '../runtime/runtime.js';

/**
 * The address of a scene page: `studio-scene://t-<treeHash>/<path>?c=<config>`. Pure, so the
 * editor builds preview addresses the same way the main process does.
 */

export const SCENE_SCHEME = 'studio-scene';

/** UTF-8 JSON as base64url, without Node's Buffer, so it runs in the renderer too. */
export function encodeSceneConfig(config: Partial<SceneConfig>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(config));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSceneConfig(value: string | null): Partial<SceneConfig> {
  if (!value) return {};
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<SceneConfig>) : {};
  } catch {
    return {};
  }
}

export function sceneUrl(
  treeHash: string,
  config: Partial<SceneConfig>,
  path = 'index.html',
): string {
  return `${SCENE_SCHEME}://t-${treeHash}/${path}?c=${encodeSceneConfig(config)}`;
}
