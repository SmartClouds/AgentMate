import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_PERMISSIONS,
  cloudflarePermission,
  missingPermissionLabels,
  permissionDeniedMessage,
  TOKEN_PAGE,
  tokenProblem,
  tokenTemplateUrl,
} from './permissions';

/**
 * The permissions Runova asks for, in the words Cloudflare's token page uses, so a guided fix
 * can say exactly what to add and nothing more.
 */

describe('the permission catalog', () => {
  it('asks for one permission per feature, labelled the way the token page shows them', () => {
    expect(CLOUDFLARE_PERMISSIONS.map((permission) => [permission.id, permission.label])).toEqual([
      ['zone', 'Zone > Zone > Read'],
      ['dns', 'Zone > DNS > Edit'],
      ['zoneSettings', 'Zone > Zone Settings > Edit'],
      ['cachePurge', 'Zone > Cache Purge > Purge'],
      ['waf', 'Zone > Zone WAF > Edit'],
      ['accessRules', 'Zone > Firewall Services > Edit'],
    ]);
    expect(cloudflarePermission('dns').purpose).toMatch(/DNS records/);
    expect(() => cloudflarePermission('billing' as never)).toThrow(/Unknown/);
  });

  it('builds the token page link with every permission filled in', () => {
    const url = new URL(tokenTemplateUrl());
    expect(`${url.origin}${url.pathname}`).toBe(TOKEN_PAGE);
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys') ?? '')).toEqual([
      { key: 'zone', type: 'read' },
      { key: 'dns', type: 'edit' },
      { key: 'zone_settings', type: 'edit' },
      { key: 'cache', type: 'purge' },
      { key: 'zone_waf', type: 'edit' },
      { key: 'firewall_services', type: 'edit' },
    ]);
    expect(url.searchParams.get('accountId')).toBe('*');
    expect(url.searchParams.get('zoneId')).toBe('all');
    expect(url.searchParams.get('name')).toBe('Runova');
  });
});

describe('the guided fix', () => {
  it('lists exactly the missing permissions, in the order the token page shows them', () => {
    expect(missingPermissionLabels(['waf', 'dns'])).toEqual([
      'Zone > DNS > Edit',
      'Zone > Zone WAF > Edit',
    ]);
    expect(missingPermissionLabels([])).toEqual([]);
  });

  it('names the permission a refused change needed', () => {
    expect(permissionDeniedMessage('dns')).toBe(
      'This token is not allowed to change DNS records. On Cloudflare, edit the token and add Zone > DNS > Edit, then check it again here.',
    );
  });
});

describe('tokenProblem', () => {
  it('lets a token through', () => {
    expect(tokenProblem('Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M')).toBeNull();
    expect(tokenProblem(`cfut_${'a1B2'.repeat(10)}`)).toBeNull();
  });

  it('explains what was pasted instead of a token', () => {
    expect(tokenProblem('')).toMatch(/Paste/);
    expect(tokenProblem('0123456789abcdef0123456789abcdef01234')).toMatch(/Global API Key/);
    expect(tokenProblem(`v1.0-${'a'.repeat(40)}`)).toMatch(/Origin CA Key/);
    expect(tokenProblem('abc def ghi jkl mno pqr stu')).toMatch(/spaces/);
    expect(tokenProblem('short')).toMatch(/too short/);
    expect(tokenProblem('x'.repeat(600))).toMatch(/too long/);
    expect(tokenProblem(`${'a'.repeat(30)}ü`)).toMatch(/characters/);
  });
});
