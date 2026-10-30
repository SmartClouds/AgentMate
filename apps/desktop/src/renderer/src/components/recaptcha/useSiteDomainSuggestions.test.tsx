import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { useSiteDomainSuggestions } from './useSiteDomainSuggestions';

/**
 * The create-key dialog suggests the sites Runova already knows about: nginx sites a server has
 * listed, WordPress sites and Cloudflare domains. It never reaches out to a server to find more.
 */

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useSiteDomainSuggestions', () => {
  it('gathers sites from what the app already loaded, without repeats', async () => {
    installRunovaBridge({
      'deployWordPress.listSites': async () => [
        { id: 'wp-1', label: 'My blog', siteUrl: 'https://Blog.example.org/' },
        { id: 'wp-2', label: 'Broken', siteUrl: 'not a url' },
      ],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.deploySites('srv-1'), [
      { settings: { id: 'shop', domains: ['shop.com', 'www.shop.com'] } },
      { settings: { id: 'empty', domains: [] } },
    ]);
    client.setQueryData(queryKeys.cloudflareAccountZones('acc-1'), [
      { id: 'z1', name: 'shop.com' },
      { id: 'z2', name: 'brand.io' },
    ]);
    const { result } = renderHook(() => useSiteDomainSuggestions(), { wrapper: wrapper(client) });
    await waitFor(() =>
      expect(result.current.some((one) => one.source === 'wordpress')).toBe(true),
    );
    expect(result.current).toEqual([
      {
        id: 'site:srv-1:shop',
        label: 'shop.com',
        domains: ['shop.com', 'www.shop.com'],
        source: 'server',
      },
      { id: 'wp:wp-1', label: 'My blog', domains: ['blog.example.org'], source: 'wordpress' },
      { id: 'zone:z2', label: 'brand.io', domains: ['brand.io'], source: 'cloudflare' },
    ]);
  });

  it('is empty when nothing is known', async () => {
    installRunovaBridge({ 'deployWordPress.listSites': async () => [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSiteDomainSuggestions(), { wrapper: wrapper(client) });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(result.current).toEqual([]);
  });
});
