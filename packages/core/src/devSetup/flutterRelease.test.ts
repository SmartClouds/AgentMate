import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  flutterBinDir,
  flutterInstallRoot,
  flutterManifestUrl,
  pickFlutterRelease,
} from './flutterRelease.js';

/**
 * Which Flutter archive to download. The manifests are trimmed copies of the real ones Google
 * publishes, so the shapes are the real shapes. Because the result is a file that gets downloaded
 * and unpacked, a manifest that points anywhere unexpected must come back as "no release".
 */

function manifest(os: 'windows' | 'macos' | 'linux'): Record<string, unknown> {
  const url = new URL(`./__fixtures__/flutter-releases-${os}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf-8')) as Record<string, unknown>;
}

describe('flutterManifestUrl', () => {
  it('is the official release list for each OS', () => {
    const base = 'https://storage.googleapis.com/flutter_infra_release/releases/';
    expect(flutterManifestUrl('win32')).toBe(`${base}releases_windows.json`);
    expect(flutterManifestUrl('darwin')).toBe(`${base}releases_macos.json`);
    expect(flutterManifestUrl('linux')).toBe(`${base}releases_linux.json`);
  });
});

describe('pickFlutterRelease', () => {
  it('picks the current stable build on Windows', () => {
    expect(pickFlutterRelease(manifest('windows'), 'win32', 'x64')).toEqual({
      version: '3.47.7',
      url: 'https://storage.googleapis.com/flutter_infra_release/releases/stable/windows/flutter_windows_3.47.7-stable.zip',
      sha256: 'c2c875da25a1a1448d18ee4e8f398b2f6fce888b4775d8f9130538e16d826cb4',
      format: 'zip',
      dartVersion: '3.13.5',
    });
  });

  it("picks the build for the Mac's own chip", () => {
    expect(pickFlutterRelease(manifest('macos'), 'darwin', 'x64')?.url).toMatch(
      /flutter_macos_3\.47\.7-stable\.zip$/,
    );
    expect(pickFlutterRelease(manifest('macos'), 'darwin', 'arm64')?.url).toMatch(
      /flutter_macos_arm64_3\.47\.7-stable\.zip$/,
    );
  });

  it('picks the tarball on Linux', () => {
    expect(pickFlutterRelease(manifest('linux'), 'linux', 'x64')).toMatchObject({
      version: '3.47.7',
      format: 'tar.xz',
    });
  });

  it('has nothing for a CPU Flutter does not publish a build for', () => {
    expect(pickFlutterRelease(manifest('windows'), 'win32', 'arm64')).toBeNull();
    expect(pickFlutterRelease(manifest('linux'), 'linux', 'arm64')).toBeNull();
    expect(pickFlutterRelease(manifest('windows'), 'win32', 'other')).toBeNull();
  });

  it('ignores a beta build and an older stable one, whatever order they are listed in', () => {
    const data = manifest('windows') as { releases: unknown[] };
    const reversed = { ...data, releases: [...data.releases].reverse() };

    expect(pickFlutterRelease(reversed, 'win32', 'x64')?.version).toBe('3.47.7');
  });

  it('treats a release with no architecture listed as x64, as the older entries are', () => {
    const data = manifest('windows') as {
      releases: Array<Record<string, unknown>>;
      current_release: { stable: string };
    };
    const releases = data.releases.map((release) => {
      if (release.hash !== data.current_release.stable) return release;
      const { dart_sdk_arch: _arch, ...rest } = release;
      return rest;
    });

    expect(pickFlutterRelease({ ...data, releases }, 'win32', 'x64')?.version).toBe('3.47.7');
  });

  it('has nothing when the list is for a different OS than the one being set up', () => {
    // A Mac list handed over for a Windows install would otherwise offer a Mac archive.
    expect(pickFlutterRelease(manifest('macos'), 'win32', 'x64')).toBeNull();
    expect(pickFlutterRelease(manifest('windows'), 'linux', 'x64')).toBeNull();
    expect(pickFlutterRelease(manifest('linux'), 'darwin', 'x64')).toBeNull();
  });

  it('has nothing when the current stable release is not in the list', () => {
    const data = manifest('windows') as Record<string, unknown>;

    expect(
      pickFlutterRelease({ ...data, current_release: { stable: 'f'.repeat(40) } }, 'win32', 'x64'),
    ).toBeNull();
  });

  describe('refuses a manifest that points anywhere unexpected', () => {
    const pickWith = (change: (data: Record<string, unknown>) => void) => {
      const data = structuredClone(manifest('windows'));
      change(data);
      return pickFlutterRelease(data, 'win32', 'x64');
    };
    const current = (data: Record<string, unknown>) => {
      const typed = data as {
        releases: Array<Record<string, unknown>>;
        current_release: { stable: string };
      };
      const found = typed.releases.find((release) => release.hash === typed.current_release.stable);
      if (!found) throw new Error('fixture has no current stable release');
      return found;
    };

    it("a download host that is not Google's", () => {
      expect(pickWith((data) => (data.base_url = 'https://evil.example/releases'))).toBeNull();
    });

    it('a download over plain http', () => {
      expect(
        pickWith(
          (data) =>
            (data.base_url = 'http://storage.googleapis.com/flutter_infra_release/releases'),
        ),
      ).toBeNull();
    });

    it('an archive path that climbs out of the releases folder', () => {
      expect(pickWith((data) => (current(data).archive = '../../evil/flutter.zip'))).toBeNull();
    });

    it('an archive path that is a full address', () => {
      expect(
        pickWith((data) => (current(data).archive = 'https://evil.example/flutter.zip')),
      ).toBeNull();
    });

    it('a checksum that is not a SHA-256', () => {
      expect(pickWith((data) => (current(data).sha256 = 'not-a-hash'))).toBeNull();
      expect(pickWith((data) => (current(data).sha256 = 'AB'.repeat(32).slice(0, 63)))).toBeNull();
    });

    it('an archive type it cannot unpack', () => {
      expect(pickWith((data) => (current(data).archive = 'stable/windows/flutter.exe'))).toBeNull();
    });

    it('a version that is not a version', () => {
      expect(pickWith((data) => (current(data).version = '1; rm -rf /'))).toBeNull();
    });
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'releases'],
    ['an array', []],
    ['an object with none of the fields', {}],
    [
      'releases that are not a list',
      {
        base_url: 'https://storage.googleapis.com/x',
        releases: 3,
        current_release: { stable: 'a' },
      },
    ],
  ])('has nothing for %s', (_label, value) => {
    expect(pickFlutterRelease(value, 'win32', 'x64')).toBeNull();
  });
});

describe('flutterInstallRoot and flutterBinDir', () => {
  it('goes in a develop folder in the home folder, without spaces, as Flutter asks', () => {
    expect(flutterInstallRoot('win32', 'C:\\Users\\me')).toBe('C:\\Users\\me\\develop\\flutter');
    expect(flutterInstallRoot('darwin', '/Users/me')).toBe('/Users/me/develop/flutter');
    expect(flutterInstallRoot('linux', '/home/me')).toBe('/home/me/develop/flutter');
  });

  it('puts the commands in bin', () => {
    expect(flutterBinDir('win32', 'C:\\Users\\me')).toBe('C:\\Users\\me\\develop\\flutter\\bin');
    expect(flutterBinDir('linux', '/home/me')).toBe('/home/me/develop/flutter/bin');
  });
});
