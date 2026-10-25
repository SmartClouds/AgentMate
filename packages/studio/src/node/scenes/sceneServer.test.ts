import { describe, expect, it, vi } from 'vitest';
import {
  encodeSceneConfig,
  injectRuntime,
  RUNTIME_PATH,
  type SceneResolver,
  sceneCsp,
  sceneUrl,
  serveScene,
} from './sceneServer.js';

const TREE = 'a'.repeat(64);
const files: Record<string, string> = {
  'index.html': '<!doctype html><html><head><title>x</title></head><body>سلام</body></html>',
  'scene.js': 'Studio.scene({ render() {} })',
  'assets/logo.svg': '<svg/>',
};

function resolver(over: Partial<SceneResolver> = {}): SceneResolver {
  return {
    treeFile: async (hash, path) =>
      hash === TREE && files[path] !== undefined ? Buffer.from(files[path] as string) : null,
    runtime: async () => Buffer.from('/* runtime */'),
    asset: async (path) => (path === 'fonts/fonts.css' ? Buffer.from('@font-face{}') : null),
    ...over,
  };
}

const text = (body: Uint8Array | string) =>
  typeof body === 'string' ? body : Buffer.from(body).toString();

describe('serveScene', () => {
  it('serves index.html with the config and runtime first in the head, under a CSP with no network', async () => {
    const url = sceneUrl(TREE, { duration: 6, lang: 'fa', dir: 'rtl' });
    expect(url).toMatch(/^studio-scene:\/\/t-a{64}\/index\.html\?c=/);
    const res = await serveScene(url, resolver());
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers['Content-Security-Policy']).toContain("connect-src 'none'");
    const html = text(res.body);
    expect(html.indexOf('<head>') + 6).toBe(html.indexOf('<script id="studio-config"'));
    expect(html).toContain('"duration":6,"lang":"fa","dir":"rtl"');
    expect(html.indexOf(`src="/${RUNTIME_PATH}"`)).toBeLessThan(html.indexOf('<title>'));
    expect(html).toContain('سلام');
  });

  it('serves the tree files, the runtime, and the index for a bare root', async () => {
    const svg = await serveScene(`studio-scene://t-${TREE}/assets/logo.svg`, resolver());
    expect(svg.headers['Content-Type']).toBe('image/svg+xml');
    expect(text(svg.body)).toBe('<svg/>');
    const runtime = await serveScene(`studio-scene://t-${TREE}/${RUNTIME_PATH}`, resolver());
    expect(runtime.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
    expect(text(runtime.body)).toBe('/* runtime */');
    const root = await serveScene(`studio-scene://t-${TREE}/`, resolver());
    expect(text(root.body)).toContain('studio-config');
  });

  it('serves the fonts stylesheet, links it in the page, and 404s a missing Studio file', async () => {
    const css = await serveScene(`studio-scene://t-${TREE}/__studio/fonts.css`, resolver());
    expect(css.headers['Content-Type']).toBe('text/css; charset=utf-8');
    expect(text(css.body)).toBe('@font-face{}');
    const font = await serveScene(
      `studio-scene://t-${TREE}/__studio/fonts/Inter.woff2`,
      resolver(),
    );
    expect(font.status).toBe(404);
    expect(
      (await serveScene(`studio-scene://t-${TREE}/__studio/other.js`, resolver())).status,
    ).toBe(404);
    const page = await serveScene(sceneUrl(TREE, {}), resolver());
    expect(text(page.body)).toContain('<link rel="stylesheet" href="/__studio/fonts.css">');
  });

  it('answers 404 for anything outside the tree', async () => {
    for (const url of [
      `studio-scene://t-${TREE}/missing.js`,
      `studio-scene://t-${TREE}/..%2Fstudio.db`,
      `studio-scene://t-${TREE}/%E0%A4%A`,
      `studio-scene://t-${'b'.repeat(64)}/index.html`,
      'studio-scene://evil/index.html',
      `https://t-${TREE}/index.html`,
      'not a url',
    ]) {
      expect((await serveScene(url, resolver())).status, url).toBe(404);
    }
  });

  it('widens the CSP only for the hosts the project allows', async () => {
    const allowedHosts = vi.fn(async () => ['cdn.example.com']);
    const res = await serveScene(`studio-scene://t-${TREE}/scene.js`, resolver({ allowedHosts }));
    expect(res.headers['Content-Security-Policy']).toContain('connect-src https://cdn.example.com');
    expect(allowedHosts).toHaveBeenCalledWith(TREE);
  });

  it('ignores a config it cannot read', async () => {
    const res = await serveScene(`studio-scene://t-${TREE}/index.html?c=%%%`, resolver());
    expect(text(res.body)).toContain(
      '<script id="studio-config" type="application/json">{}</script>',
    );
    expect(encodeSceneConfig({ lang: 'en' })).not.toContain('=');
  });
});

describe('injectRuntime', () => {
  it('escapes the config so it cannot close its script element', () => {
    const html = injectRuntime('<head></head>', { params: { title: '</script><script>alert(1)' } });
    expect(html).not.toContain('</script><script>alert');
    expect(html).toContain('\\u003c/script>');
  });

  it('adds a head to a page without one', () => {
    expect(injectRuntime('<div>x</div>', {})).toMatch(
      /^<!doctype html><head><meta charset="utf-8"><script/,
    );
    expect(injectRuntime('<HEAD lang="fa"><title>t</title>', {})).toMatch(
      /^<HEAD lang="fa"><script id/,
    );
  });
});

describe('sceneCsp', () => {
  it('blocks every network, frame and form by default', () => {
    const csp = sceneCsp();
    for (const part of [
      "default-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ]) {
      expect(csp).toContain(part);
    }
  });
});
