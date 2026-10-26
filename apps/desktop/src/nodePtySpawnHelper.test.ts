import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * node-pty runs a small program, spawn-helper, to start every terminal on macOS. Version 1.1.0
 * publishes it without the execute bit, and then every shell and agent tab fails with
 * "posix_spawnp failed". The desktop package's postinstall sets the bit for local development,
 * the afterPack hook repairs and asserts the staged copy so a broken bit never ships, and the
 * pty host verifies and repairs the helper at runtime before every spawn.
 */

const SCRIPT = join(__dirname, '..', 'scripts', 'fix-node-pty-spawn-helper.mjs');
const EXECUTABLE = 0o111;

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

// Windows has no execute bit, and node-pty starts its terminals another way there.
describe.skipIf(process.platform === 'win32')('node-pty spawn-helper', () => {
  it('is made executable without touching the file it is linked to', () => {
    scratch = mkdtempSync(join(tmpdir(), 'runova-node-pty-'));
    const store = join(scratch, 'store-file');
    writeFileSync(store, 'helper');
    chmodSync(store, 0o644);
    const prebuild = join(scratch, 'node-pty', 'prebuilds', 'darwin-arm64');
    mkdirSync(prebuild, { recursive: true });
    // pnpm hard links package files to its shared store, so a chmod in place would reach it.
    linkSync(store, join(prebuild, 'spawn-helper'));

    execFileSync(process.execPath, [SCRIPT, join(scratch, 'node-pty')]);

    expect(statSync(join(prebuild, 'spawn-helper')).mode & 0o777).toBe(0o755);
    expect(statSync(store).mode & 0o777).toBe(0o644);
  });

  it('is executable in the installed node-pty', () => {
    const require = createRequire(join(__dirname, '..', 'package.json'));
    const prebuilds = join(dirname(require.resolve('node-pty/package.json')), 'prebuilds');
    const helpers = readdirSync(prebuilds)
      .filter((platform) => platform.startsWith('darwin-'))
      .map((platform) => join(prebuilds, platform, 'spawn-helper'));

    expect(helpers.length).toBeGreaterThan(0);
    for (const helper of helpers) {
      expect(statSync(helper).mode & EXECUTABLE, helper).toBe(EXECUTABLE);
    }
  });
});

/**
 * node-pty finds spawn-helper beside its binding and swaps `app.asar` for `app.asar.unpacked`,
 * since a program cannot run from inside the archive. The packaged pty host runs in plain Node
 * mode and loads node-pty from app.asar.unpacked already, so the stock swap turned the path into
 * `app.asar.unpacked.unpacked` and every macOS release terminal failed with "posix_spawnp
 * failed". patches/node-pty@1.1.0.patch makes the swap leave an unpacked path alone.
 */
describe('node-pty spawn-helper path', () => {
  // Runs the installed node-pty's own rewrite lines on a sample path.
  function rewrite(helperPath: string): string {
    const require = createRequire(join(__dirname, '..', 'package.json'));
    const source = readFileSync(
      join(dirname(require.resolve('node-pty/package.json')), 'lib', 'unixTerminal.js'),
      'utf8',
    );
    const lines = source
      .split(/\r?\n/)
      .filter((line) => line.startsWith('helperPath = helperPath.replace('));
    expect(lines.length).toBeGreaterThan(0);
    return new Function('helperPath', `${lines.join('\n')}\nreturn helperPath;`)(helperPath);
  }

  const resources = '/Applications/Runova.app/Contents/Resources';
  const helper = 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper';

  it('points a node-pty loaded from the archive at the unpacked helper', () => {
    expect(rewrite(`${resources}/app.asar/${helper}`)).toBe(
      `${resources}/app.asar.unpacked/${helper}`,
    );
  });

  it('keeps the path of a node-pty loaded from app.asar.unpacked', () => {
    expect(rewrite(`${resources}/app.asar.unpacked/${helper}`)).toBe(
      `${resources}/app.asar.unpacked/${helper}`,
    );
  });
});
