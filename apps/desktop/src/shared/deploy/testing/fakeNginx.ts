import type {
  CertificateInfo,
  CertificateIssueRequest,
  CertificateRemoveRequest,
  CertificateUploadRequest,
  CertificateUploadResult,
  JobInfo,
  NginxApplyResult,
  NginxProblemInfo,
  NginxStatus,
  SiteInfo,
  SiteLogKind,
  SiteSaveResult,
  SiteSettings,
  SiteSnippets,
  StreamProxyInfo,
  StreamProxySaveResult,
  StreamProxySettings,
} from '../protocol/generated/Runova.ServerCore.Contracts';

/**
 * nginx and its certificates inside a `FakeCore` (E10, E11), with the core's rules where the
 * desktop leans on them: saving checks and stores without going live, applying puts every saved
 * change live (or reports problems and keeps what ran), the first order from a CA needs its terms
 * accepted, and installing, issuing and renewing are jobs a test finishes with `complete`.
 */

const ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const DAY = 24 * 60 * 60_000;
/** Directives the core's snippet allowlist turns away, as far as the tests need. */
const FORBIDDEN = /^\s*(include|load_module|lua_\w+|perl\w*)\b/;

export interface FakeNginxHost {
  now(): number;
  startJob(kind: JobInfo['kind'], title: string, options?: { resource?: string }): JobInfo;
  finishJob(jobId: string, state: 'succeeded' | 'failed'): JobInfo;
  deliverSiteLog(siteId: string, kind: SiteLogKind, lines: string[], reset: boolean): void;
}

export class FakeNginx {
  status: NginxStatus = {
    installed: true,
    running: true,
    managed: false,
    fromNginxOrg: false,
    streamSupported: true,
    pendingChanges: false,
    seLinuxEnabled: false,
    version: '1.30.0',
  };
  readonly sites = new Map<string, SiteInfo>();
  readonly streams = new Map<string, StreamProxyInfo>();
  /** CAs (by staging or not) whose terms were accepted from this server. */
  readonly acceptedTerms = new Set<boolean>();
  /** The next apply fails with these problems, then applying works again. */
  failNextApply: NginxProblemInfo[] | null = null;
  readonly logs = new Map<string, string[]>();
  private readonly pending = new Map<string, () => void>();

  constructor(private readonly host: FakeNginxHost) {}

  certificates(): CertificateInfo[] {
    return [...this.sites.values()].flatMap((site) =>
      site.certificate ? [{ ...site.certificate }] : [],
    );
  }

  install(): JobInfo {
    const job = this.host.startJob('nginxInstall', 'Install nginx', { resource: 'nginx' });
    this.pending.set(job.id, () => {
      this.status = { ...this.status, installed: true, running: true, managed: true };
    });
    return job;
  }

  saveSite(settings: SiteSettings): SiteSaveResult {
    const problems = this.siteProblems(settings);
    if (problems.length > 0) return { problems };
    const known = this.sites.get(settings.id);
    const site: SiteInfo = {
      ...known,
      settings: { ...settings },
      applied: false,
      createdAtUnixMs: known?.createdAtUnixMs ?? this.host.now(),
      updatedAtUnixMs: this.host.now(),
    };
    this.sites.set(settings.id, site);
    this.status = { ...this.status, pendingChanges: true };
    return { problems: [], site: { ...site } };
  }

  setSnippets(snippets: SiteSnippets): SiteSaveResult {
    const site = this.site(snippets.siteId);
    const problems = [
      ...snippetProblems(snippets.siteId, 'serverSnippet', snippets.serverSnippet),
      ...snippetProblems(snippets.siteId, 'locationSnippet', snippets.locationSnippet),
    ];
    if (problems.length > 0) return { problems };
    const { serverSnippet: _server, locationSnippet: _location, ...rest } = site;
    const next: SiteInfo = {
      ...rest,
      ...(snippets.serverSnippet ? { serverSnippet: snippets.serverSnippet } : {}),
      ...(snippets.locationSnippet ? { locationSnippet: snippets.locationSnippet } : {}),
      applied: false,
      updatedAtUnixMs: this.host.now(),
    };
    this.sites.set(site.settings.id, next);
    this.status = { ...this.status, pendingChanges: true };
    return { problems: [], site: { ...next } };
  }

  deleteSite(siteId: string): void {
    this.site(siteId);
    this.sites.delete(siteId);
    this.status = { ...this.status, pendingChanges: true };
  }

  saveStream(settings: StreamProxySettings): StreamProxySaveResult {
    const field = `streams[${settings.id}]`;
    const problems: NginxProblemInfo[] = [];
    if (!ID.test(settings.id)) problems.push({ field: `${field}.id`, message: 'Bad id.' });
    if (settings.listenPort === 22 || settings.listenPort < 1 || settings.listenPort > 65_535) {
      problems.push({ field: `${field}.listenPort`, message: 'That port cannot be used.' });
    }
    if (problems.length > 0) return { problems };
    const proxy: StreamProxyInfo = {
      settings: { ...settings },
      applied: false,
      updatedAtUnixMs: this.host.now(),
    };
    this.streams.set(settings.id, proxy);
    this.status = { ...this.status, pendingChanges: true };
    return { problems: [], proxy: { ...proxy } };
  }

  deleteStream(proxyId: string): void {
    if (!this.streams.delete(proxyId)) throw new Error('There is no such stream proxy.');
    this.status = { ...this.status, pendingChanges: true };
  }

  apply(): NginxApplyResult {
    if (!this.status.managed) {
      return { applied: false, problems: [], warnings: [], error: 'Install nginx first.' };
    }
    if (this.failNextApply) {
      const problems = this.failNextApply;
      this.failNextApply = null;
      return { applied: false, problems, warnings: [], error: 'nginx -t failed.' };
    }
    const release = (this.status.currentRelease ?? 0) + 1;
    for (const [id, site] of this.sites) this.sites.set(id, { ...site, applied: true });
    for (const [id, proxy] of this.streams) this.streams.set(id, { ...proxy, applied: true });
    this.status = {
      ...this.status,
      pendingChanges: false,
      currentRelease: release,
      lastAppliedAtUnixMs: this.host.now(),
    };
    return { applied: true, problems: [], warnings: [], release };
  }

  issue(request: CertificateIssueRequest): JobInfo {
    const site = this.site(request.siteId);
    if (!request.acceptTermsOfService && !this.acceptedTerms.has(request.staging)) {
      throw new Error("Accept the certificate authority's terms of service first.");
    }
    this.acceptedTerms.add(request.staging);
    const job = this.host.startJob(
      'certificateIssue',
      `Issue a certificate for ${site.settings.domains[0]}`,
      {
        resource: `site:${request.siteId}`,
      },
    );
    this.pending.set(job.id, () => this.certify(request.siteId, request.staging, job.id));
    return job;
  }

  renew(siteId: string): JobInfo {
    const site = this.site(siteId);
    if (!site.certificate) throw new Error('This site has no certificate to renew.');
    const job = this.host.startJob(
      'certificateRenew',
      `Renew the certificate for ${site.settings.domains[0]}`,
      {
        resource: `site:${siteId}`,
      },
    );
    this.pending.set(job.id, () =>
      this.certify(siteId, site.certificate?.staging ?? false, job.id),
    );
    return job;
  }

  upload(request: CertificateUploadRequest): CertificateUploadResult {
    this.site(request.siteId);
    const problems: string[] = [];
    if (!request.certificatePem.includes('BEGIN CERTIFICATE')) {
      problems.push('That is not a PEM certificate.');
    }
    if (!request.privateKeyPem.includes('PRIVATE KEY')) problems.push('That is not a PEM key.');
    if (problems.length > 0) return { problems };
    const certificate = this.certify(request.siteId, false, undefined, 'uploaded');
    return { problems: [], certificate, apply: this.apply() };
  }

  /** A Cloudflare Origin CA certificate for the key the core made (E14): stored and applied. */
  installOrigin(siteId: string): CertificateUploadResult {
    const certificate = this.certify(siteId, false, undefined, 'cloudflareOrigin');
    const site = this.site(siteId);
    this.sites.set(siteId, {
      ...site,
      certificate: {
        ...certificate,
        issuer: 'CloudFlare Origin SSL ECC Certificate Authority',
        notAfterUnixMs: certificate.notBeforeUnixMs + 15 * 365 * DAY,
      },
    });
    return {
      problems: [],
      certificate: { ...this.site(siteId).certificate! },
      apply: this.apply(),
    };
  }

  removeCertificate(request: CertificateRemoveRequest): NginxApplyResult {
    const site = this.site(request.siteId);
    if (!site.certificate) throw new Error('This site has no certificate.');
    const { certificate: _gone, ...rest } = site;
    this.sites.set(request.siteId, {
      ...rest,
      settings: { ...site.settings, redirectToHttps: false, hsts: undefined },
    });
    return this.apply();
  }

  /** Finishes an install, issue or renew job the way the core would. */
  complete(jobId: string, state: 'succeeded' | 'failed' = 'succeeded'): JobInfo {
    const effect = this.pending.get(jobId);
    this.pending.delete(jobId);
    if (state === 'succeeded') effect?.();
    return this.host.finishJob(jobId, state);
  }

  /** nginx writes to a site's log (or rotates it first, with `reset`). */
  writeLog(siteId: string, kind: SiteLogKind, lines: string[], reset = false): void {
    const key = `${siteId}:${kind}`;
    this.logs.set(key, [...(reset ? [] : (this.logs.get(key) ?? [])), ...lines]);
    this.host.deliverSiteLog(siteId, kind, lines, reset);
  }

  tail(siteId: string, kind: SiteLogKind, count = 100): string[] {
    return (this.logs.get(`${siteId}:${kind}`) ?? []).slice(-count);
  }

  site(siteId: string): SiteInfo {
    const site = this.sites.get(siteId);
    if (!site) throw new Error('There is no such site.');
    return site;
  }

  private certify(
    siteId: string,
    staging: boolean,
    jobId?: string,
    source: CertificateInfo['source'] = 'acme',
  ): CertificateInfo {
    const site = this.site(siteId);
    const now = this.host.now();
    const certificate: CertificateInfo = {
      siteId,
      source,
      state: 'valid',
      domains: [...site.settings.domains],
      issuer: staging ? '(STAGING) Pretend CA' : 'Pretend CA',
      notBeforeUnixMs: now,
      notAfterUnixMs: now + 90 * DAY,
      autoRenew: source === 'acme',
      staging,
      failedAttempts: 0,
      ...(source === 'acme' ? { renewAtUnixMs: now + 60 * DAY, lastAttemptAtUnixMs: now } : {}),
      ...(jobId ? { lastJobId: jobId } : {}),
    };
    this.sites.set(siteId, { ...site, certificate, applied: true });
    return { ...certificate };
  }

  private siteProblems(settings: SiteSettings): NginxProblemInfo[] {
    const field = `sites[${settings.id}]`;
    const problems: NginxProblemInfo[] = [];
    if (!ID.test(settings.id)) {
      problems.push({
        field: `${field}.id`,
        message: 'A site id is lowercase letters, digits and hyphens.',
      });
    }
    if (settings.domains.length === 0) {
      problems.push({ field: `${field}.domains`, message: 'A site needs 1 to 50 domains.' });
    }
    settings.domains.forEach((domain, index) => {
      if (!DOMAIN.test(domain)) {
        problems.push({
          field: `${field}.domains[${index}]`,
          message: `'${domain}' is not a valid host name.`,
        });
      }
    });
    return problems.map((problem) => ({ ...problem, siteId: settings.id }));
  }
}

function snippetProblems(siteId: string, name: string, text?: string): NginxProblemInfo[] {
  if (!text) return [];
  return text.split('\n').flatMap((line, index) =>
    FORBIDDEN.test(line)
      ? [
          {
            field: `sites[${siteId}].${name}`,
            message: `${line.trim().split(/\s/)[0]} is not allowed in a snippet.`,
            line: index + 1,
            siteId,
          },
        ]
      : [],
  );
}
