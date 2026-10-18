import { describe, expect, it } from 'vitest';
import { suggestRemoteProjects } from './match.js';
import { parseSentryProjects } from './sentry/parse.js';
import { sentryProjects } from './testing/sentryFixtures.js';
import type { LinkCandidateProject, RemoteProject } from './types.js';

const remote = parseSentryProjects(sentryProjects);

function remoteProject(slug: string, name = slug): RemoteProject {
  return { id: slug, slug, name, platform: null };
}

function slugs(project: Partial<LinkCandidateProject>, projects = remote): string[] {
  return suggestRemoteProjects(
    { name: '', folderPath: null, repoUrl: null, ...project },
    projects,
  ).map((match) => match.slug);
}

describe('suggestRemoteProjects', () => {
  it('suggests every project that carries the name, and not the others', () => {
    expect(slugs({ name: 'Storefront', folderPath: 'E:/code/storefront' })).toEqual([
      'storefront-web',
      'storefront-api',
    ]);
  });

  it("matches the folder's name, with Windows or POSIX separators", () => {
    expect(slugs({ name: 'Payments', folderPath: 'E:\\code\\billing-worker\\' })).toEqual([
      'billing-worker',
    ]);
    expect(slugs({ name: 'Payments', folderPath: '/home/me/billing-worker' })).toEqual([
      'billing-worker',
    ]);
  });

  it("matches the repository's name in https and ssh form", () => {
    expect(
      slugs({ name: 'Payments', repoUrl: 'https://github.com/acme/billing-worker.git' }),
    ).toEqual(['billing-worker']);
    expect(slugs({ name: 'Payments', repoUrl: 'git@github.com:acme/billing-worker.git' })).toEqual([
      'billing-worker',
    ]);
    expect(slugs({ name: 'Payments', repoUrl: 'https://gitlab.com/acme/billing-worker/' })).toEqual(
      ['billing-worker'],
    );
  });

  it('puts the closer match first when the generic words break a tie', () => {
    expect(slugs({ name: 'Storefront', folderPath: 'E:/code/storefront-api' })).toEqual([
      'storefront-api',
      'storefront-web',
    ]);
    expect(
      slugs({ name: 'Storefront', repoUrl: 'git@github.com:acme/storefront-web.git' }),
    ).toEqual(['storefront-web', 'storefront-api']);
  });

  it('reads names written together or in other cases as the same name', () => {
    expect(slugs({ name: 'Store Front' })).toEqual(['storefront-web', 'storefront-api']);
    expect(slugs({ name: 'BillingWorker' })).toEqual(['billing-worker']);
    expect(slugs({ name: 'BILLING' })).toEqual(['billing-worker']);
  });

  it('matches a longer name that holds the remote one', () => {
    expect(slugs({ name: 'storefront2' })).toEqual(['storefront-web', 'storefront-api']);
  });

  it('does not match on generic words alone', () => {
    expect(slugs({ name: 'Billing API' })).toEqual(['billing-worker']);
    expect(slugs({ name: 'Admin Web' })).toEqual([]);
  });

  it('still matches a project whose name is only generic words', () => {
    const projects = [remoteProject('web'), remoteProject('api'), remoteProject('docs')];
    expect(slugs({ name: 'Web App' }, projects)).toEqual(['web']);
  });

  it('matches on the remote name as well as the slug', () => {
    const projects = [
      remoteProject('proj-7', 'Inventory Service'),
      remoteProject('proj-8', 'Docs'),
    ];
    expect(slugs({ name: 'inventory' }, projects)).toEqual(['proj-7']);
  });

  it('suggests nothing when nothing fits or there is nothing to pick from', () => {
    expect(slugs({ name: 'Marketing site' })).toEqual([]);
    expect(slugs({ name: 'Storefront' }, [])).toEqual([]);
    expect(slugs({ name: '', folderPath: '', repoUrl: '' })).toEqual([]);
    expect(slugs({ name: '---' })).toEqual([]);
  });
});
