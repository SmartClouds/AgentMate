import { describe, expect, it } from 'vitest';
import { rememberable, restoreTarget } from './rememberedSelection';

/**
 * The Deploy page remembers what it had open, so a bare `/deploy` (the sidebar link) opens it
 * again. One-shot params are left out, and an address that names something always wins.
 */

function params(query = ''): URLSearchParams {
  return new URLSearchParams(query);
}

describe('rememberable', () => {
  it('keeps the selection, the section and what is open inside it', () => {
    expect(rememberable(params('server=srv-2&view=apps&app=web&new=1'))).toBe(
      'server=srv-2&view=apps&app=web&new=1',
    );
    expect(rememberable(params('files=fs-1&view=settings'))).toBe('files=fs-1&view=settings');
    expect(rememberable(params('site=wp-1&view=deploys'))).toBe('site=wp-1&view=deploys');
    expect(rememberable(params('server=srv-1&view=containers&tab=images'))).toBe(
      'server=srv-1&view=containers&tab=images',
    );
    expect(rememberable(params('cloudflare=1&zone=z-1&tab=ssl&account=acc-1'))).toBe(
      'cloudflare=1&zone=z-1&tab=ssl',
    );
  });

  it('leaves out the one-shot params', () => {
    expect(
      rememberable(params('server=srv-1&view=websites&newSite=example.com&dialog=cloudflare')),
    ).toBe('server=srv-1&view=websites');
    expect(rememberable(params('server=srv-1&view=firewall&fix=enable-firewall'))).toBe(
      'server=srv-1&view=firewall',
    );
  });

  it('is null when nothing is selected', () => {
    expect(rememberable(params(''))).toBeNull();
    expect(rememberable(params('dialog=cloudflare'))).toBeNull();
    expect(rememberable(params('view=logs'))).toBeNull();
  });
});

describe('restoreTarget', () => {
  it('opens what was remembered on a bare address', () => {
    expect(restoreTarget(params(''), 'server=srv-2&view=logs')?.toString()).toBe(
      'server=srv-2&view=logs',
    );
  });

  it('opens the Cloudflare page again', () => {
    expect(restoreTarget(params(''), 'cloudflare=1&zone=z-1')?.toString()).toBe(
      'cloudflare=1&zone=z-1',
    );
  });

  it('leaves an older Cloudflare dialog link alone, since it names the Cloudflare page', () => {
    expect(restoreTarget(params('dialog=cloudflare'), 'site=wp-1')).toBeNull();
  });

  it('leaves an address that names something alone', () => {
    expect(restoreTarget(params('server=srv-1'), 'server=srv-2&view=logs')).toBeNull();
    expect(restoreTarget(params('files=fs-1&view=settings'), 'server=srv-2')).toBeNull();
    expect(restoreTarget(params('site=wp-1'), 'server=srv-2')).toBeNull();
    expect(restoreTarget(params('cloudflare=1'), 'server=srv-2')).toBeNull();
  });

  it('has nothing to restore with nothing remembered', () => {
    expect(restoreTarget(params(''), null)).toBeNull();
    expect(restoreTarget(params(''), '')).toBeNull();
  });

  it('drops one-shot params that got into the memory', () => {
    expect(
      restoreTarget(params(''), 'server=srv-1&fix=restore-rules&view=firewall')?.toString(),
    ).toBe('server=srv-1&view=firewall');
  });
});
