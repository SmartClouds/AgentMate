import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import SeoHead from '../src/components/SeoHead.astro';

let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create({ astroConfig: { site: 'https://runovahq.com' } });
});

function render(props: Record<string, unknown>, url = 'https://runovahq.com/features/relay') {
  return container.renderToString(SeoHead, { props, request: new Request(url) });
}

function jsonLd(html: string) {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(match, 'JSON-LD script').not.toBeNull();
  return JSON.parse(match?.[1] ?? 'null');
}

describe('SeoHead', () => {
  const props = {
    title: 'Relay',
    description: 'Split work into tasks that each fit one AI coding session and run them in order.',
  };

  it('renders the title from the template and the description', async () => {
    const html = await render(props);
    expect(html).toContain('<title>Relay | Runova</title>');
    expect(html).toContain(`<meta name="description" content="${props.description}"`);
  });

  it('renders the canonical URL', async () => {
    const html = await render(props, 'https://runovahq.com/features/relay?utm_source=x');
    expect(html).toContain('<link rel="canonical" href="https://runovahq.com/features/relay"');
  });

  it('renders the Open Graph tags', async () => {
    const html = await render(props);
    expect(html).toContain('<meta property="og:title" content="Relay | Runova"');
    expect(html).toContain(`<meta property="og:description" content="${props.description}"`);
    expect(html).toContain('<meta property="og:url" content="https://runovahq.com/features/relay"');
    expect(html).toContain('<meta property="og:type" content="website"');
    expect(html).toContain('<meta property="og:site_name" content="Runova"');
    expect(html).toContain(
      '<meta property="og:image" content="https://runovahq.com/og/default.png"',
    );
    expect(html).toContain('<meta property="og:image:width" content="1200"');
    expect(html).toContain('<meta property="og:image:height" content="630"');
    expect(html).toMatch(/<meta property="og:image:alt" content="[^"]+"/);
  });

  it('renders the Twitter card', async () => {
    const html = await render(props);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
    expect(html).toContain('<meta name="twitter:title" content="Relay | Runova"');
    expect(html).toContain(`<meta name="twitter:description" content="${props.description}"`);
    expect(html).toContain(
      '<meta name="twitter:image" content="https://runovahq.com/og/default.png"',
    );
  });

  it('renders Organization and WebSite JSON-LD on every page, then the page nodes', async () => {
    const html = await render({
      ...props,
      jsonLd: [{ '@type': 'SoftwareApplication', name: 'Runova' }],
    });
    const data = jsonLd(html);
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@graph'].map((node: { '@type': string }) => node['@type'])).toEqual([
      'Organization',
      'WebSite',
      'SoftwareApplication',
    ]);
  });

  it('uses the home title without the template', async () => {
    const html = await render({ description: props.description }, 'https://runovahq.com/');
    expect(html).toContain('<title>Runova: the Agentic Development Environment</title>');
    expect(html).toContain('<link rel="canonical" href="https://runovahq.com/"');
  });

  it('marks a page noindex when asked', async () => {
    const html = await render({ ...props, noindex: true });
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"');
  });
});
