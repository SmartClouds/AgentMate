import { describe, expect, it, vi } from 'vitest';

/** `studio-scene:` in Electron: requests go to the package's scene server through the service. */

const service = vi.hoisted(() => ({
  sceneFile: vi.fn(async ({ path }: { path: string }) =>
    path === 'index.html' ? Buffer.from('<head></head><p>سلام</p>') : null,
  ),
  sceneHosts: vi.fn(async () => ['cdn.example.com']),
  assets: {
    runtimeFile: 'runtime.js',
    read: vi.fn(async (path: string) =>
      path === 'fonts/fonts.css' ? Buffer.from('@font-face{}') : null,
    ),
  },
}));
const files = vi.hoisted(() => ({ fail: false }));
vi.mock('./index', () => ({ studioService: () => service }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(async () => {
    if (files.fail) throw new Error('missing');
    return Buffer.from('/* runtime */');
  }),
}));

const { handleStudioScenes, STUDIO_SCHEME_PRIVILEGES, studioSceneResolver } = await import(
  './protocol'
);

const TREE = 'a'.repeat(64);

function fakeProtocol() {
  let handler: ((request: Request) => Promise<Response>) | null = null;
  return {
    target: { handle: (_scheme: string, fn: typeof handler) => void (handler = fn) },
    fetch: (url: string) => (handler as NonNullable<typeof handler>)(new Request(url)),
  };
}

describe('studio-scene protocol', () => {
  it('is a secure, standard scheme that allows fetch and cross-origin reads', () => {
    expect(STUDIO_SCHEME_PRIVILEGES).toEqual({
      scheme: 'studio-scene',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    });
  });

  it('serves a scene page from the service with its own CSP, widened for the project hosts', async () => {
    const p = fakeProtocol();
    handleStudioScenes(p.target as never);
    const page = await p.fetch(`studio-scene://t-${TREE}/index.html`);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain(
      'connect-src https://cdn.example.com',
    );
    expect(await page.text()).toContain('سلام');
    expect(service.sceneFile).toHaveBeenCalledWith({ treeHash: TREE, path: 'index.html' });
    expect((await p.fetch(`studio-scene://t-${TREE}/missing.js`)).status).toBe(404);
  });

  it('serves the runtime once read, the fonts, and tries the runtime again after a failed read', async () => {
    const p = fakeProtocol();
    handleStudioScenes(p.target as never);
    const css = await p.fetch(`studio-scene://t-${TREE}/__studio/fonts.css`);
    expect(await css.text()).toBe('@font-face{}');

    files.fail = true;
    await expect(studioSceneResolver.runtime()).rejects.toThrow(/missing/);
    files.fail = false;
    const runtime = await p.fetch(`studio-scene://t-${TREE}/__studio/runtime.js`);
    expect(await runtime.text()).toBe('/* runtime */');
  });
});
