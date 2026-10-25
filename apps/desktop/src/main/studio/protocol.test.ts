import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

describe('studio-media protocol', () => {
  const HASH = 'b'.repeat(64);

  it('is a secure, standard scheme that streams', async () => {
    const { STUDIO_MEDIA_PRIVILEGES } = await import('./protocol');
    expect(STUDIO_MEDIA_PRIVILEGES).toEqual({
      scheme: 'studio-media',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    });
  });

  it('serves the file the service names, with the request headers, and the preview file type', async () => {
    const { handleStudioMedia } = await import('./protocol');
    const { net } = await import('electron');
    const fetched: { url: string; range: string | null }[] = [];
    vi.mocked(net.fetch).mockImplementation(async (url, init) => {
      fetched.push({ url: String(url), range: new Headers(init?.headers).get('range') });
      return new Response('bytes', {
        status: 206,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    });
    const lookup = vi.fn(async ({ variant }: { variant: string }) =>
      variant === 'peaks' ? null : join(tmpdir(), 'cache', `${variant}.mp4`),
    );
    let handler: ((request: Request) => Promise<Response>) | null = null;
    handleStudioMedia(
      { handle: (_s: string, fn: typeof handler) => void (handler = fn) } as never,
      lookup,
    );
    const serve = (url: string, headers?: HeadersInit) =>
      (handler as NonNullable<typeof handler>)(new Request(url, { headers }));

    const proxy = await serve(`studio-media://m/v1/${HASH}/proxy`, { Range: 'bytes=0-99' });
    expect(proxy.status).toBe(206);
    expect(proxy.headers.get('Content-Type')).toBe('video/mp4');
    expect(fetched[0]).toEqual({
      url: pathToFileURL(join(tmpdir(), 'cache', 'proxy.mp4')).toString(),
      range: 'bytes=0-99',
    });
    expect(lookup).toHaveBeenCalledWith({ videoId: 'v1', hash: HASH, variant: 'proxy' });

    const original = await serve(`studio-media://m/v1/${HASH}/original`);
    expect(original.headers.get('Content-Type')).toBe('application/octet-stream');
    expect((await serve(`studio-media://m/v1/${HASH}/peaks`)).status).toBe(404);
    expect((await serve('studio-media://m/v1/../etc/proxy')).status).toBe(404);
    expect(lookup).toHaveBeenCalledTimes(3);
  });
});
