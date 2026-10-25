import { describe, expect, it } from 'vitest';
import { appCsp, keepsOwnCsp } from './appCsp';

/**
 * The app's CSP, spelled out in full, so any change to it is a deliberate one. E33 added only
 * `frame-src` (for Studio's scene previews); E35 added `studio-media:` to images, media and
 * connections (for imported media); everything else is as it was.
 */

const options = {
  blueprintScheme: 'blueprint-file',
  studioSceneScheme: 'studio-scene',
  studioMediaScheme: 'studio-media',
};

describe('appCsp', () => {
  it('locks the packaged app down to its own files, plus scene previews in frames', () => {
    expect(appCsp({ ...options, isDev: false })).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blueprint-file: studio-media:; media-src 'self' blueprint-file: studio-media:; font-src 'self' data:; connect-src 'self' data: ws://127.0.0.1:* studio-media:; worker-src 'self' blob:; frame-src 'self' studio-scene:;",
    );
  });

  it('lets the dev server in during development', () => {
    expect(appCsp({ ...options, isDev: true })).toBe(
      "default-src 'self' http://localhost:5173 ws://localhost:5173; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' http://localhost:5173; style-src 'self' 'unsafe-inline'; img-src 'self' data: blueprint-file: studio-media:; media-src 'self' blueprint-file: studio-media:; font-src 'self' data:; connect-src 'self' data: ws://127.0.0.1:* studio-media: http://localhost:5173 ws://localhost:5173; worker-src 'self' blob:; frame-src 'self' http://localhost:5173 studio-scene:;",
    );
  });
});

describe('keepsOwnCsp', () => {
  it('leaves scene pages their own policy and gives every other page the app policy', () => {
    expect(keepsOwnCsp('studio-scene://t-abc/index.html', 'studio-scene')).toBe(true);
    expect(keepsOwnCsp('http://localhost:5173/', 'studio-scene')).toBe(false);
    expect(keepsOwnCsp('file:///C:/app/index.html', 'studio-scene')).toBe(false);
  });
});
