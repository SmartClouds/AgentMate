import { describe, expect, it } from 'vitest';
import {
  browsableRepoUrl,
  isClonableGithubUrl,
  normalizeCloneUrl,
  stripRemoteCredentials,
} from './remoteUrl.js';

/**
 * A remote cloned with a token is stored verbatim, so anything that shows or opens
 * the address has to drop the credentials first. The link this builds is also the
 * one "Open on GitHub" hands to the OS browser, which is why an unrecognized scheme
 * is passed through rather than guessed at.
 */

describe('stripRemoteCredentials', () => {
  it('removes a user:token pair from an https remote', () => {
    expect(stripRemoteCredentials('https://user:ghp_secret@github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
  });

  it('removes a bare username with no password', () => {
    expect(stripRemoteCredentials('https://user@github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
  });

  it('removes credentials from an ssh:// remote and from other schemes', () => {
    expect(stripRemoteCredentials('ssh://git@github.com/org/repo.git')).toBe(
      'ssh://github.com/org/repo.git',
    );
    expect(stripRemoteCredentials('git+https://user:pw@example.com/org/repo')).toBe(
      'git+https://example.com/org/repo',
    );
  });

  it('leaves an address with no userinfo alone', () => {
    expect(stripRemoteCredentials('https://github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
  });

  it('leaves the scp-style form alone, since it has no password field', () => {
    expect(stripRemoteCredentials('git@github.com:org/repo.git')).toBe(
      'git@github.com:org/repo.git',
    );
  });

  it('trims surrounding whitespace, which a copied remote often carries', () => {
    expect(stripRemoteCredentials('  https://user:pw@github.com/org/repo  ')).toBe(
      'https://github.com/org/repo',
    );
  });

  it('is not fooled by an @ that appears after the path starts', () => {
    // The userinfo part cannot contain a slash, so this @ belongs to the path.
    expect(stripRemoteCredentials('https://github.com/org/repo@v1')).toBe(
      'https://github.com/org/repo@v1',
    );
  });
});

describe('browsableRepoUrl', () => {
  it('turns an scp-style remote into an https link', () => {
    expect(browsableRepoUrl('git@github.com:me/my-app.git')).toBe('https://github.com/me/my-app');
    expect(browsableRepoUrl('git@github.com:me/my-app')).toBe('https://github.com/me/my-app');
  });

  it('handles an scp-style remote on an enterprise host with a nested group path', () => {
    expect(browsableRepoUrl('git@git.corp.example.com:team/group/repo.git')).toBe(
      'https://git.corp.example.com/team/group/repo',
    );
  });

  it('handles an ssh:// remote, with or without the user and the port', () => {
    expect(browsableRepoUrl('ssh://git@github.com/me/my-app.git')).toBe(
      'https://github.com/me/my-app',
    );
    expect(browsableRepoUrl('ssh://github.com/me/my-app')).toBe('https://github.com/me/my-app');
    expect(browsableRepoUrl('ssh://git@ssh.dev.azure.com:22/org/project/repo')).toBe(
      'https://ssh.dev.azure.com/org/project/repo',
    );
  });

  it('keeps a full https URL, minus the .git suffix and any credentials', () => {
    expect(browsableRepoUrl('https://github.com/me/my-app.git')).toBe(
      'https://github.com/me/my-app',
    );
    expect(browsableRepoUrl('https://user:ghp_secret@github.com/me/my-app.git')).toBe(
      'https://github.com/me/my-app',
    );
  });

  it('keeps a self-hosted https URL with a port and a subgroup path', () => {
    expect(browsableRepoUrl('https://gitlab.corp.example:8443/group/sub/repo.git')).toBe(
      'https://gitlab.corp.example:8443/group/sub/repo',
    );
  });

  it('adds https:// to a bare host/owner/repo someone copied from the address bar', () => {
    expect(browsableRepoUrl('github.com/me/my-app')).toBe('https://github.com/me/my-app');
    expect(browsableRepoUrl('github.com/me/my-app.git')).toBe('https://github.com/me/my-app');
  });

  it('leaves an address in some other scheme exactly as typed', () => {
    expect(browsableRepoUrl('http://github.com/me/my-app')).toBe('http://github.com/me/my-app');
    expect(browsableRepoUrl('file:///home/me/repos/my-app')).toBe('file:///home/me/repos/my-app');
  });

  it("returns '' for empty and whitespace-only input", () => {
    expect(browsableRepoUrl('')).toBe('');
    expect(browsableRepoUrl('   ')).toBe('');
    // A remote that is nothing but ".git" has no address left once the suffix goes.
    expect(browsableRepoUrl('.git')).toBe('');
  });

  it('never carries a credential into the link it produces', () => {
    const inputs = [
      'https://user:ghp_secret@github.com/me/my-app.git',
      'ssh://git@github.com/me/my-app.git',
      'git+https://user:pw@example.com/me/my-app',
    ];
    for (const input of inputs) {
      expect(browsableRepoUrl(input), input).not.toContain('ghp_secret');
      expect(browsableRepoUrl(input), input).not.toContain(':pw@');
    }
  });

  it('does not crash on malformed input, it just prefixes it', () => {
    // Nothing here parses as a remote, so the fallback treats it as a bare host path.
    expect(browsableRepoUrl('not a url at all')).toBe('https://not a url at all');
    expect(browsableRepoUrl('://')).toBe('https://://');
  });
});

describe('normalizeCloneUrl / isClonableGithubUrl', () => {
  it('accepts https, bare, scp-style and ssh GitHub addresses', () => {
    expect(normalizeCloneUrl('https://github.com/me/my-app')).toBe('https://github.com/me/my-app');
    expect(normalizeCloneUrl('https://github.com/me/my-app.git')).toBe(
      'https://github.com/me/my-app',
    );
    expect(normalizeCloneUrl('github.com/me/my-app')).toBe('https://github.com/me/my-app');
    expect(normalizeCloneUrl('git@github.com:me/my-app.git')).toBe('https://github.com/me/my-app');
    expect(normalizeCloneUrl('ssh://git@github.com/me/my-app.git')).toBe(
      'https://github.com/me/my-app',
    );
    expect(isClonableGithubUrl('github.com/me/my-app')).toBe(true);
  });

  it('keeps only owner/repo from a link deeper into the repo', () => {
    expect(normalizeCloneUrl('https://github.com/me/my-app/tree/main')).toBe(
      'https://github.com/me/my-app',
    );
    expect(normalizeCloneUrl('https://github.com/me/my-app/blob/main/src/index.ts')).toBe(
      'https://github.com/me/my-app',
    );
    expect(normalizeCloneUrl('github.com/me/my-app/pulls?q=is%3Aopen')).toBe(
      'https://github.com/me/my-app',
    );
    expect(normalizeCloneUrl('https://github.com/me/my-app#readme')).toBe(
      'https://github.com/me/my-app',
    );
    expect(normalizeCloneUrl('https://www.github.com/me/my-app')).toBe(
      'https://github.com/me/my-app',
    );
  });

  it('strips embedded credentials before normalizing', () => {
    expect(normalizeCloneUrl('https://user:ghp_secret@github.com/me/my-app.git')).toBe(
      'https://github.com/me/my-app',
    );
  });

  it('rejects local paths, file URLs and non-GitHub hosts (v1 scope)', () => {
    for (const input of [
      '',
      '   ',
      'C:\\code\\app',
      '\\\\share\\repo',
      '/home/me/repo',
      '../repo',
      'file:///home/me/repo',
      'https://gitlab.com/me/app',
      'git@gitlab.com:me/app.git',
      'https://github.com/only-owner',
      'github.com/only-owner/',
      'https://notgithub.com/me/app',
      'not a url at all',
    ]) {
      expect(normalizeCloneUrl(input), input).toBeNull();
      expect(isClonableGithubUrl(input), input).toBe(false);
    }
  });
});
