import { describe, expect, it } from 'vitest';
import type { SiteSettings } from '../protocol/generated/Runova.ServerCore.Contracts';
import { FakeCore } from './fakeCore';

/** The fake core's nginx keeps the rules the desktop's tests lean on. */

const SITE: SiteSettings = {
  id: 'blog',
  domains: ['blog.example.com'],
  upstream: { kind: 'servicePort', port: 3000, verifyCertificate: true, sendUpstreamHost: false },
  websocket: false,
  gzip: true,
  http2: true,
  redirectToHttps: true,
  hsts: { maxAgeSeconds: 60, includeSubdomains: false, preload: false },
};

function nginx() {
  const core = new FakeCore(() => 1_000);
  return { core, nginx: core.nginx };
}

describe('FakeNginx', () => {
  it('refuses a bad id, no domains and a bad stream port', () => {
    const { nginx: web } = nginx();
    expect(
      web.saveSite({ ...SITE, id: 'Bad_Id', domains: [] }).problems.map((p) => p.field),
    ).toEqual(['sites[Bad_Id].id', 'sites[Bad_Id].domains']);
    const proxy = web.saveStream({
      id: '-x',
      protocol: 'udp',
      listenPort: 22,
      upstream: SITE.upstream,
    });
    expect(proxy.problems.map((p) => p.field)).toEqual([
      'streams[-x].id',
      'streams[-x].listenPort',
    ]);
    expect(() => web.deleteStream('none')).toThrow(/no such stream proxy/);
  });

  it('keeps nginx as it ran when told to fail, and asks for an install first', () => {
    const { nginx: web } = nginx();
    expect(web.apply()).toMatchObject({ applied: false, error: 'Install nginx first.' });
    web.status = { ...web.status, managed: true };
    web.saveSite(SITE);
    web.failNextApply = [{ field: 'sites[blog].locationSnippet', message: 'bad', line: 2 }];
    expect(web.apply()).toMatchObject({ applied: false, problems: [{ line: 2 }] });
    expect(web.apply()).toMatchObject({ applied: true, release: 1 });
    expect(web.apply().release).toBe(2);
  });

  it('remembers accepted terms, fails a job without effect, and refuses what is not there', () => {
    const { core, nginx: web } = nginx();
    web.saveSite(SITE);
    expect(() => web.renew('blog')).toThrow(/no certificate to renew/);
    expect(() =>
      web.removeCertificate({ siteId: 'blog', revoke: false, reason: 'unspecified' }),
    ).toThrow(/has no certificate/);
    const failed = web.issue({
      siteId: 'blog',
      acceptTermsOfService: true,
      staging: false,
      preferDns01: false,
    });
    expect(web.complete(failed.id, 'failed').state).toBe('failed');
    expect(web.certificates()).toEqual([]);

    const again = web.issue({
      siteId: 'blog',
      acceptTermsOfService: false,
      staging: false,
      preferDns01: false,
    });
    web.complete(again.id);
    expect(web.certificates()[0]).toMatchObject({ issuer: 'Pretend CA', autoRenew: true });
    const renewal = web.renew('blog');
    web.complete(renewal.id);
    expect(core.job(renewal.id).info.state).toBe('succeeded');

    web.removeCertificate({ siteId: 'blog', revoke: true, reason: 'keyCompromise' });
    expect(web.site('blog').settings.redirectToHttps).toBe(false);
    expect(() => web.site('none')).toThrow(/no such site/);
  });

  it('checks uploads, keeps logs and trims snippets away', () => {
    const { nginx: web } = nginx();
    web.saveSite(SITE);
    expect(
      web.upload({ siteId: 'blog', certificatePem: 'x', privateKeyPem: 'y' }).problems,
    ).toHaveLength(2);
    web.writeLog('blog', 'access', ['a', 'b']);
    expect(web.tail('blog', 'access')).toEqual(['a', 'b']);
    expect(web.tail('blog', 'error')).toEqual([]);

    web.setSnippets({ siteId: 'blog', serverSnippet: 'charset utf-8;', locationSnippet: 'a;' });
    const cleared = web.setSnippets({ siteId: 'blog' });
    expect(cleared.site).not.toHaveProperty('serverSnippet');
    expect(cleared.site).not.toHaveProperty('locationSnippet');
    web.deleteSite('blog');
    expect(web.status.pendingChanges).toBe(true);
  });
});
