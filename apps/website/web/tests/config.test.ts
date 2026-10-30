import { describe, expect, it } from 'vitest';
import config from '../astro.config.mjs';

describe('astro.config.mjs', () => {
  it('proxies /api and /media to the API in development', () => {
    const proxy = config.vite?.server?.proxy as Record<string, { target: string }>;
    expect(proxy['/api'].target).toBe(process.env.WEBSITE_API_URL || 'http://localhost:5180');
    expect(proxy['/media'].target).toBe(proxy['/api'].target);
  });

  it('builds URLs without a trailing slash for the configured site', () => {
    expect(config.trailingSlash).toBe('never');
    expect(config.site).toBe(process.env.SITE_URL || 'https://runovahq.com');
  });

  it('serves on-demand routes with the Node adapter in standalone mode', () => {
    expect(config.adapter?.name).toBe('@astrojs/node');
  });
});
