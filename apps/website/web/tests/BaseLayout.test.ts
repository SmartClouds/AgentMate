import { loadRenderers } from 'astro:container';
import { getContainerRenderer as reactRenderer } from '@astrojs/react/container-renderer';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import BaseLayout from '../src/layouts/BaseLayout.astro';

let html: string;

beforeAll(async () => {
  const renderers = await loadRenderers([reactRenderer()]);
  const container = await AstroContainer.create({
    renderers,
    astroConfig: { site: 'https://runovahq.com' },
  });
  html = await container.renderToString(BaseLayout, {
    props: { title: 'Test', description: 'A page used by the layout test, long enough to count.' },
    slots: { default: '<p>Page body</p>' },
    request: new Request('https://runovahq.com/test'),
  });
});

describe('BaseLayout', () => {
  it('is an English document that starts in Dark', () => {
    expect(html).toMatch(/<html[^>]* lang="en"/);
    expect(html).toMatch(/<html[^>]* class="dark"/);
  });

  it('sets the theme in an inline head script before any stylesheet', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    const script = head.indexOf('runova-theme');
    expect(script).toBeGreaterThan(-1);
    const stylesheet = head.search(/<link rel="stylesheet"|<style/);
    if (stylesheet !== -1) expect(script).toBeLessThan(stylesheet);
  });

  it('puts a skip link first in the body that targets the main content', () => {
    const body = html.slice(html.indexOf('<body'));
    const firstLink = body.match(/<a [^>]*>/)?.[0] ?? '';
    expect(firstLink).toContain('href="#main"');
    expect(body).toMatch(/<main[^>]* id="main"/);
    expect(body).toContain('Skip to content');
  });

  it('renders the header, the slot inside main, and the footer in that order', () => {
    const header = html.indexOf('<header');
    const main = html.indexOf('<main');
    const content = html.indexOf('<p>Page body</p>');
    const footer = html.indexOf('<footer');
    expect(header).toBeGreaterThan(-1);
    expect(main).toBeGreaterThan(header);
    expect(content).toBeGreaterThan(main);
    expect(footer).toBeGreaterThan(content);
  });

  it('has a labelled theme toggle in the header', () => {
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(header).toMatch(/<button[^>]*aria-label="Switch to (light|dark) theme"/);
  });

  it('includes the SEO head', () => {
    expect(html).toContain('<title>Test | Runova</title>');
    expect(html).toContain('<link rel="canonical" href="https://runovahq.com/test"');
  });
});
