import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../test/main/fixtures';
import {
  githubReleaseSource,
  localArtifactSource,
  parseReleaseManifest,
  releaseDownloadUrl,
  repoReleaseDirectory,
} from './releaseSource';

/**
 * The app only installs a server core it can verify: the release manifest (embedded in the app
 * build, or written by `server-core:publish` in development) names each tarball's SHA-256, and a
 * file that does not match is refused before it goes anywhere near a server.
 */

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

function manifestFor(files: Record<string, string>, version = '1.53.0') {
  return {
    version,
    assets: Object.entries(files).map(([rid, content]) => ({
      rid,
      file: `agentmate-core-${version}-${rid}.tar.gz`,
      sha256: sha256(content),
      size: Buffer.byteLength(content),
    })),
  };
}

describe('parseReleaseManifest', () => {
  it('reads a well-formed manifest', () => {
    const manifest = manifestFor({ 'linux-x64': 'x', 'linux-arm64': 'y' });

    expect(parseReleaseManifest(manifest)).toEqual(manifest);
  });

  it.each([
    ['a missing version', { assets: [] }],
    ['an odd version', { version: '1.0 && reboot', assets: [] }],
    [
      'an unknown runtime',
      {
        version: '1.0.0',
        assets: [{ rid: 'win-x64', file: 'x', sha256: 'ab'.repeat(32), size: 1 }],
      },
    ],
    [
      'a bad checksum',
      {
        version: '1.0.0',
        assets: [
          {
            rid: 'linux-x64',
            file: 'agentmate-core-1.0.0-linux-x64.tar.gz',
            sha256: 'nope',
            size: 1,
          },
        ],
      },
    ],
    [
      'a file name that is not a release',
      {
        version: '1.0.0',
        assets: [{ rid: 'linux-x64', file: '../../etc/passwd', sha256: 'ab'.repeat(32), size: 1 }],
      },
    ],
    ['not an object', 'manifest'],
  ])('refuses %s', (_case, value) => {
    expect(() => parseReleaseManifest(value)).toThrow(/release manifest/);
  });
});

describe('localArtifactSource', () => {
  it('uses a published build that matches its checksum', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'agentmate-core-0.0.0-dev-linux-x64.tar.gz'), 'tarball');
    writeFileSync(
      join(dir, 'server-core-manifest.json'),
      JSON.stringify(manifestFor({ 'linux-x64': 'tarball' }, '0.0.0-dev')),
    );

    const release = await localArtifactSource(dir).release('linux-x64');

    expect(release).toEqual({
      version: '0.0.0-dev',
      rid: 'linux-x64',
      file: 'agentmate-core-0.0.0-dev-linux-x64.tar.gz',
      sha256: sha256('tarball'),
      localPath: join(dir, 'agentmate-core-0.0.0-dev-linux-x64.tar.gz'),
    });
  });

  it('refuses a build that no longer matches its checksum', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'agentmate-core-0.0.0-dev-linux-x64.tar.gz'), 'tampered');
    writeFileSync(
      join(dir, 'server-core-manifest.json'),
      JSON.stringify(manifestFor({ 'linux-x64': 'tarball' }, '0.0.0-dev')),
    );

    await expect(localArtifactSource(dir).release('linux-x64')).rejects.toThrow(
      /does not match its published checksum/,
    );
  });

  it('explains what to run when nothing was published', async () => {
    await expect(localArtifactSource(tempDir()).release('linux-x64')).rejects.toThrow(
      /pnpm server-core:publish linux-x64/,
    );
  });

  it('explains a runtime that was not published', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'server-core-manifest.json'),
      JSON.stringify(manifestFor({ 'linux-x64': 'x' }, '0.0.0-dev')),
    );

    await expect(localArtifactSource(dir).release('linux-arm64')).rejects.toThrow(/linux-arm64/);
  });
});

describe('githubReleaseSource', () => {
  it('downloads the release asset for the app version once, then reuses it', async () => {
    const cache = tempDir();
    const download = vi.fn(async (_url: string, destination: string) => {
      writeFileSync(destination, 'release bytes');
    });
    const source = githubReleaseSource(
      manifestFor({ 'linux-x64': 'release bytes' }),
      cache,
      download,
    );

    const first = await source.release('linux-x64');
    const second = await source.release('linux-x64');

    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(
      releaseDownloadUrl('1.53.0', 'agentmate-core-1.53.0-linux-x64.tar.gz'),
      first.localPath,
    );
    expect(second.localPath).toBe(first.localPath);
    expect(first.sha256).toBe(sha256('release bytes'));
  });

  it('throws away a download that does not match, and says so', async () => {
    const cache = tempDir();
    const source = githubReleaseSource(
      manifestFor({ 'linux-x64': 'release bytes' }),
      cache,
      async (_url, destination) => {
        writeFileSync(destination, 'something else');
      },
    );

    await expect(source.release('linux-x64')).rejects.toThrow(
      /does not match its published checksum/,
    );
    expect(existsSync(join(cache, 'agentmate-core-1.53.0-linux-x64.tar.gz'))).toBe(false);
  });

  it('points at the GitHub release for the version', () => {
    expect(releaseDownloadUrl('1.53.0', 'agentmate-core-1.53.0-linux-x64.tar.gz')).toBe(
      'https://github.com/SmartClouds/AgentMate/releases/download/v1.53.0/agentmate-core-1.53.0-linux-x64.tar.gz',
    );
  });

  describe('remote', () => {
    const manifest = manifestFor({ 'linux-x64': 'x64 bytes', 'linux-arm64': 'arm bytes' });

    it('names the public address and the checksum the app holds, without downloading', () => {
      const download = vi.fn();
      const source = githubReleaseSource(manifest, tempDir(), download);

      expect(source.remote?.('linux-arm64')).toEqual({
        version: '1.53.0',
        rid: 'linux-arm64',
        file: 'agentmate-core-1.53.0-linux-arm64.tar.gz',
        sha256: sha256('arm bytes'),
        url: 'https://github.com/SmartClouds/AgentMate/releases/download/v1.53.0/agentmate-core-1.53.0-linux-arm64.tar.gz',
      });
      expect(download).not.toHaveBeenCalled();
    });

    it('has nothing for a processor the app build has no release for', () => {
      const source = githubReleaseSource(manifestFor({ 'linux-x64': 'x' }), tempDir(), vi.fn());

      expect(source.remote?.('linux-arm64')).toBeNull();
    });

    it('is the same release the app would download itself', async () => {
      const source = githubReleaseSource(manifest, tempDir(), async (_url, destination) => {
        writeFileSync(destination, 'x64 bytes');
      });

      const remote = source.remote?.('linux-x64');
      const local = await source.release('linux-x64');

      expect(remote).toMatchObject({
        version: local.version,
        file: local.file,
        sha256: local.sha256,
      });
    });
  });
});

describe('localArtifactSource has no public address', () => {
  it('leaves it to the app to upload a development build', () => {
    expect(localArtifactSource(tempDir()).remote).toBeUndefined();
  });
});

describe('repoReleaseDirectory', () => {
  it('finds the publish output from the desktop app and from any build folder under it', () => {
    const repo = tempDir();
    mkdirSync(join(repo, 'apps', 'server-core'), { recursive: true });
    const build = join(repo, 'apps', 'desktop', 'out-verify', 'main');
    mkdirSync(build, { recursive: true });
    const expected = join(repo, 'apps', 'server-core', 'artifacts', 'release');

    expect(repoReleaseDirectory(join(repo, 'apps', 'desktop'))).toBe(expected);
    expect(repoReleaseDirectory(build)).toBe(expected);
  });

  it('finds nothing outside a checkout', () => {
    expect(repoReleaseDirectory(tempDir())).toBeNull();
  });
});
