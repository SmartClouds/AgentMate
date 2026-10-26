import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  findStagedNodePtyDirs,
  stagedMacHelpers,
  verifyStagedNodePtyDir,
} from '../scripts/after-pack-spawn-helper.cjs';
import { tempDir } from './test/main/fixtures';

/**
 * The electron-builder afterPack hook that keeps a broken node-pty spawn-helper from shipping:
 * without the execute bit every macOS terminal fails at runtime with "posix_spawnp failed".
 * Real directories, injected checks, so it runs on any OS.
 */

function writeHelper(root: string, ...parts: string[]): string {
  const helper = join(root, ...parts);
  mkdirSync(join(helper, '..'), { recursive: true });
  writeFileSync(helper, 'helper');
  return helper;
}

describe('findStagedNodePtyDirs', () => {
  it('finds the unpacked node-pty in a mac staging layout', () => {
    const out = tempDir('runova-afterpack-');
    const staged = join(
      out,
      'mac-arm64',
      'Runova.app',
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
    );
    writeHelper(staged, 'package.json');

    expect(findStagedNodePtyDirs(out)).toEqual([staged]);
  });

  it('ignores a node-pty that is still packed inside the archive', () => {
    const out = tempDir('runova-afterpack-');
    writeHelper(out, 'mac-arm64', 'Runova.app', 'Contents', 'Resources', 'app.asar');

    expect(findStagedNodePtyDirs(out)).toEqual([]);
  });

  it('finds nothing in an empty staging dir', () => {
    expect(findStagedNodePtyDirs(tempDir('runova-afterpack-'))).toEqual([]);
  });
});

describe('stagedMacHelpers', () => {
  it('lists the macOS helpers and skips other platforms', () => {
    const staged = tempDir('runova-node-pty-');
    const arm = writeHelper(staged, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    const x64 = writeHelper(staged, 'prebuilds', 'darwin-x64', 'spawn-helper');
    const built = writeHelper(staged, 'build', 'Release', 'spawn-helper');
    writeHelper(staged, 'prebuilds', 'linux-x64', 'spawn-helper');

    expect(stagedMacHelpers(staged)).toEqual([arm, x64, built]);
  });

  it('is empty when nothing is staged', () => {
    expect(stagedMacHelpers(tempDir('runova-node-pty-'))).toEqual([]);
  });
});

describe('verifyStagedNodePtyDir', () => {
  const depsFor = (executable: Set<string>) => ({
    platform: 'darwin',
    exists: existsSync,
    isExecutable: (path: string) => executable.has(path),
    repair: vi.fn(),
  });

  it('repairs the staged copy, then passes when every helper is executable', () => {
    const dir = tempDir('runova-node-pty-');
    const helper = writeHelper(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    const deps = depsFor(new Set([helper]));

    expect(verifyStagedNodePtyDir(dir, deps)).toEqual([helper]);
    expect(deps.repair).toHaveBeenCalledWith(dir);
  });

  it('fails the packaging naming the helper that stayed broken', () => {
    const dir = tempDir('runova-node-pty-');
    const helper = writeHelper(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    const deps = depsFor(new Set());
    let thrown: unknown;
    try {
      verifyStagedNodePtyDir(dir, deps);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain('not executable');
    expect(String(thrown)).toContain(helper);
  });

  it('lists staging without checking modes on a Windows build machine', () => {
    const dir = tempDir('runova-node-pty-');
    const helper = writeHelper(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    const deps = {
      platform: 'win32',
      exists: existsSync,
      isExecutable: () => {
        throw new Error('must not check modes on Windows');
      },
      repair: vi.fn(),
    };
    expect(verifyStagedNodePtyDir(dir, deps)).toEqual([helper]);
    expect(deps.repair).toHaveBeenCalledTimes(1);
  });
});
