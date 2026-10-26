import { describe, expect, it } from 'vitest';
import {
  analyzeGithubScopes,
  GH_REFRESH_COMMAND,
  githubNewTokenUrl,
  normalizeRegistry,
  parseScopesHeader,
  registryCredentialProblem,
  registryLabel,
  registryOfImage,
} from './registries';

describe('registries', () => {
  it.each([
    ['ghcr.io', 'ghcr.io'],
    ['GHCR.IO', 'ghcr.io'],
    ['index.docker.io', 'docker.io'],
    ['https://index.docker.io/v1/', 'docker.io'],
    ['registry.example.com:5000', 'registry.example.com:5000'],
    ['https://ghcr.io/', 'ghcr.io'],
    ['localhost:5000', 'localhost:5000'],
  ])('names %s by its host', (value, host) => {
    expect(normalizeRegistry(value)).toBe(host);
  });

  it.each([
    '',
    'ghcr.io/org',
    'ghcr.io:0',
    'ghcr.io:99999',
    'http://ghcr.io',
    'bad..host',
    'a b',
    'ghcr.io\n',
  ])('refuses %j as a registry', (value) => {
    expect(normalizeRegistry(value)).toBeNull();
  });

  it.each([
    ['nginx:1.29', 'docker.io'],
    ['someone/app', 'docker.io'],
    ['ghcr.io/acme/web:1.0', 'ghcr.io'],
    ['localhost/app', 'localhost'],
    ['registry.example.com:5000/team/app@sha256:abc', 'registry.example.com:5000'],
    ['Registry.Example.com/app', 'registry.example.com'],
  ])('finds the registry of %s', (image, host) => {
    expect(registryOfImage(image)).toBe(host);
  });

  it('opens GitHub on a classic token with only read:packages', () => {
    const url = new URL(githubNewTokenUrl());
    expect(url.origin + url.pathname).toBe('https://github.com/settings/tokens/new');
    expect(url.searchParams.get('scopes')).toBe('read:packages');
    expect(url.searchParams.get('description')).toMatch(/Runova/);
  });

  it('reads the scopes header the way GitHub writes it', () => {
    expect(parseScopesHeader('repo, workflow,  read:packages ')).toEqual([
      'repo',
      'workflow',
      'read:packages',
    ]);
    expect(parseScopesHeader('')).toEqual([]);
    expect(parseScopesHeader(null)).toEqual([]);
  });

  it('a packages-only token pulls and is not broader', () => {
    expect(analyzeGithubScopes(['read:packages'])).toEqual({ canPull: true, broaderScopes: [] });
  });

  it('write:packages pulls too, and counts as broader', () => {
    expect(analyzeGithubScopes(['write:packages'])).toEqual({
      canPull: true,
      broaderScopes: ['write:packages'],
    });
  });

  it('a gh sign-in without packages cannot pull and lists what is broader', () => {
    expect(analyzeGithubScopes(['gist', 'read:org', 'repo', 'workflow'])).toEqual({
      canPull: false,
      broaderScopes: ['gist', 'read:org', 'repo', 'workflow'],
    });
  });

  it('offers the gh command that adds the packages scope', () => {
    expect(GH_REFRESH_COMMAND).toBe('gh auth refresh -h github.com -s read:packages');
  });

  it('labels the well-known registries', () => {
    expect(registryLabel('ghcr.io')).toBe('GitHub Container Registry');
    expect(registryLabel('docker.io')).toBe('Docker Hub');
    expect(registryLabel('registry.example.com')).toBe('registry.example.com');
  });

  it('checks a user name and secret as the core does', () => {
    expect(registryCredentialProblem('octocat', 'a-long-token')).toBeNull();
    expect(registryCredentialProblem('', 'a-long-token')).toMatch(/user name/);
    expect(registryCredentialProblem('has:colon', 'a-long-token')).toMatch(/colon/);
    expect(registryCredentialProblem('octocat', 'abc')).toMatch(/at least 4/);
    expect(registryCredentialProblem('octocat', 'two\nlines')).toMatch(/one line/);
    expect(registryCredentialProblem('octocat', 'x'.repeat(4097))).toMatch(/4096/);
  });
});
