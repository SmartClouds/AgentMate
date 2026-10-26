import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../test/main/fixtures';
import { ensureSpawnHelper, type SpawnHelperEnv, spawnHelperCandidates } from './spawnHelper';

/**
 * node-pty starts every macOS terminal through its spawn-helper, which version 1.1.0 ships
 * without the execute bit. Every case below is a way that failure reached a user as the
 * cryptic "posix_spawnp failed": the install-time postinstall only covers the machine it ran
 * on, so the pty host verifies and repairs the helper at runtime instead.
 *
 * The filesystem probes are injected, so everything but the repair itself runs on any OS; the
 * repair runs for real on POSIX, where mode bits exist.
 */

const DARWIN = { platform: 'darwin', arch: 'arm64' } as const;

function fakeTree(helpers: Record<string, 'ok' | 'broken'>): {
  env: SpawnHelperEnv;
  repaired: string[];
} {
  const dir = tempDir('runova-spawn-helper-');
  const existing = new Set(Object.keys(helpers));
  const broken = new Set(
    Object.entries(helpers)
      .filter(([, state]) => state === 'broken')
      .map(([name]) => join(dir, name)),
  );
  const repaired: string[] = [];
  const env: SpawnHelperEnv = {
    ...DARWIN,
    // A node-pty tree holding exactly the helpers this case asks for.
    nodePtyDir: dir,
    exists: (path) => existing.has(path.slice(dir.length + 1).replace(/\\/g, '/')),
    isExecutable: (path) => !broken.has(path),
    repair: (path) => {
      repaired.push(path);
      broken.delete(path);
      return null;
    },
  };
  return { env, repaired };
}

describe('spawnHelperCandidates', () => {
  it('prefers a source build over the prebuilt helper, like node-pty itself', () => {
    expect(spawnHelperCandidates('/pty', 'darwin', 'arm64')).toEqual([
      join('/pty', 'build', 'Release', 'spawn-helper'),
      join('/pty', 'build', 'Debug', 'spawn-helper'),
      join('/pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    ]);
  });
});

describe('ensureSpawnHelper', () => {
  it('is a no-op where terminals do not go through the helper', () => {
    const exists = vi.fn(() => {
      throw new Error('must not touch the filesystem');
    });
    for (const platform of ['win32', 'linux'] as const) {
      expect(ensureSpawnHelper({ platform, exists })).toEqual({ ok: true, path: '', detail: '' });
    }
    expect(exists).not.toHaveBeenCalled();
  });

  it('passes a healthy helper without repairing anything', () => {
    const { env, repaired } = fakeTree({ 'prebuilds/darwin-arm64/spawn-helper': 'ok' });
    const check = ensureSpawnHelper(env);
    expect(check.ok).toBe(true);
    expect(check.detail).toBe('');
    expect(repaired).toEqual([]);
  });

  it('repairs a helper that lost its execute bit and says so', () => {
    const { env, repaired } = fakeTree({ 'prebuilds/darwin-arm64/spawn-helper': 'broken' });
    const check = ensureSpawnHelper(env);
    expect(check.ok).toBe(true);
    expect(repaired).toHaveLength(1);
    expect(check.path).toBe(repaired[0]);
    expect(check.detail).toContain('repaired');
    expect(check.detail).toContain(repaired[0]);
  });

  it('checks every helper, source builds first', () => {
    const { env, repaired } = fakeTree({
      'build/Release/spawn-helper': 'broken',
      'prebuilds/darwin-arm64/spawn-helper': 'broken',
    });
    expect(ensureSpawnHelper(env).ok).toBe(true);
    expect(repaired.map((path) => path.replace(/\\/g, '/'))).toEqual([
      expect.stringContaining('build/Release/spawn-helper'),
      expect.stringContaining('prebuilds/darwin-arm64/spawn-helper'),
    ]);
  });

  it('fails fast naming the helper when the bit cannot be restored', () => {
    const { env } = fakeTree({ 'prebuilds/darwin-arm64/spawn-helper': 'broken' });
    env.repair = () => 'EACCES: permission denied';
    const check = ensureSpawnHelper(env);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('spawn-helper');
    expect(check.detail).toContain('EACCES: permission denied');
    expect(check.detail).toContain(check.path);
    expect(check.path).toContain('spawn-helper');
  });

  it('fails fast when node-pty cannot be located', () => {
    const check = ensureSpawnHelper({ ...DARWIN, nodePtyDir: null });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('node-pty');
  });

  it('fails fast when no helper exists at all', () => {
    const { env } = fakeTree({});
    const check = ensureSpawnHelper(env);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('no node-pty spawn-helper found');
    expect(check.detail).toContain('darwin-arm64');
  });

  it('looks beside the archive when node-pty resolved inside it', () => {
    const dir = tempDir('runova-spawn-helper-');
    const unpacked = join(dir, 'app.asar.unpacked', 'node-pty');
    const helper = join('prebuilds', 'darwin-arm64', 'spawn-helper');
    const env: SpawnHelperEnv = {
      ...DARWIN,
      nodePtyDir: join(dir, 'app.asar', 'node-pty'),
      exists: (path) => path === join(unpacked, helper),
      isExecutable: () => true,
      repair: () => {
        throw new Error('must not repair a healthy helper');
      },
    };
    const check = ensureSpawnHelper(env);
    expect(check.ok).toBe(true);
    expect(check.path).toBe(join(unpacked, helper));
  });

  // Mode bits do not exist on Windows; the repair itself only runs on POSIX.
  it.skipIf(process.platform === 'win32')('repairs a real helper on disk', () => {
    const dir = tempDir('runova-spawn-helper-');
    const helperDir = join(dir, 'prebuilds', 'darwin-arm64');
    mkdirSync(helperDir, { recursive: true });
    const helper = join(helperDir, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\n', 'utf-8');
    chmodSync(helper, 0o644);

    const check = ensureSpawnHelper({ ...DARWIN, nodePtyDir: dir });

    expect(check.ok).toBe(true);
    expect(check.detail).toContain('repaired');
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform === 'win32')('leaves a real healthy helper alone', () => {
    const dir = tempDir('runova-spawn-helper-');
    const helperDir = join(dir, 'prebuilds', 'darwin-arm64');
    mkdirSync(helperDir, { recursive: true });
    const helper = join(helperDir, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\n', 'utf-8');
    chmodSync(helper, 0o755);

    const check = ensureSpawnHelper({ ...DARWIN, nodePtyDir: dir });

    expect(check.ok).toBe(true);
    expect(check.detail).toBe('');
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });
});
