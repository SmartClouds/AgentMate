import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appBundleFor, INSTALL_SCRIPT, pickMacZip, prepareMacUpdate } from './macInstall';
import { DownloadFatalError } from './resumableDownload';

describe('appBundleFor', () => {
  it('walks up from the main executable to the .app bundle', () => {
    expect(appBundleFor('/Applications/AgentMate.app/Contents/MacOS/AgentMate')).toBe(
      '/Applications/AgentMate.app',
    );
  });

  it('returns null when the executable is not inside a bundle', () => {
    expect(appBundleFor('/usr/local/bin/electron')).toBeNull();
  });
});

describe('pickMacZip', () => {
  const both = [
    '/v1.2.3/AgentMate-1.2.3-arm64-mac.zip',
    '/v1.2.3/AgentMate-1.2.3-arm64.dmg',
    '/v1.2.3/AgentMate-1.2.3-mac.zip',
  ];

  it('gives an Apple Silicon Mac the arm64 zip', () => {
    expect(pickMacZip(both, true)).toBe('/v1.2.3/AgentMate-1.2.3-arm64-mac.zip');
  });

  it('gives an Intel Mac the x64 zip', () => {
    expect(pickMacZip(both, false)).toBe('/v1.2.3/AgentMate-1.2.3-mac.zip');
  });

  it('never gives an Intel Mac an arm64 zip, even when it is the only one', () => {
    expect(pickMacZip(['/AgentMate-1.2.3-arm64-mac.zip'], false)).toBeNull();
  });

  it('lets an Apple Silicon Mac fall back to the Intel zip, which runs under Rosetta', () => {
    expect(pickMacZip(['/AgentMate-1.2.3-mac.zip'], true)).toBe('/AgentMate-1.2.3-mac.zip');
  });

  it('ignores dmg files', () => {
    expect(pickMacZip(['/AgentMate-1.2.3-arm64.dmg'], true)).toBeNull();
  });
});

describe('prepareMacUpdate', () => {
  it('refuses a translocated copy, which it could never replace', async () => {
    const prepared = prepareMacUpdate({
      zipPath: '/tmp/update.zip',
      execPath:
        '/private/var/folders/x/AppTranslocation/ABC/d/AgentMate.app/Contents/MacOS/AgentMate',
      workDir: '/tmp/work',
    });
    await expect(prepared).rejects.toBeInstanceOf(DownloadFatalError);
    await expect(prepared).rejects.toThrow(/Applications folder/);
  });

  it('refuses when the executable is not inside a bundle', async () => {
    await expect(
      prepareMacUpdate({
        zipPath: '/tmp/update.zip',
        execPath: '/usr/local/bin/electron',
        workDir: '/tmp/work',
      }),
    ).rejects.toBeInstanceOf(DownloadFatalError);
  });
});

function hasShell(): boolean {
  return spawnSync('sh', ['-c', 'exit 0']).status === 0;
}

describe.skipIf(!hasShell())('INSTALL_SCRIPT', () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function setup(): { target: string; staging: string; staged: string; script: string } {
    root = mkdtempSync(join(tmpdir(), 'agentmate-mac-install-'));
    const target = join(root, 'AgentMate.app');
    const staging = join(root, '.AgentMate-update');
    const staged = join(staging, 'AgentMate.app');
    mkdirSync(target, { recursive: true });
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(target, 'version'), 'old');
    writeFileSync(join(staged, 'version'), 'new');
    const script = join(root, 'install-update.sh');
    writeFileSync(script, INSTALL_SCRIPT);
    return { target, staging, staged, script };
  }

  function runScript(args: string[]): Promise<number | null> {
    return new Promise((resolve) => {
      spawn('sh', args, { stdio: 'ignore' }).on('exit', resolve);
    });
  }

  // Git Bash's `kill -0` can't reliably see native Windows PIDs, so the wait is only
  // meaningful where sh and the app share a process table.
  it.skipIf(process.platform === 'win32')(
    'waits for the app to exit, then swaps in the new bundle and cleans up',
    async () => {
      const { target, staging, staged, script } = setup();
      const app = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], { stdio: 'ignore' });
      let appExitedAt = 0;
      app.on('exit', () => {
        appExitedAt = Date.now();
      });
      const log = join(root, 'install.log');

      const code = await runScript([script, String(app.pid), target, staged, staging, '0', log]);

      expect(code).toBe(0);
      // The swap must not finish before the app has exited.
      expect(appExitedAt).toBeGreaterThan(0);
      expect(readFileSync(join(target, 'version'), 'utf8')).toBe('new');
      expect(existsSync(staging)).toBe(false);
      expect(readFileSync(log, 'utf8')).toContain('installed');
    },
  );

  it('puts the old bundle back when the new one cannot be moved in', async () => {
    const { target, staging, script } = setup();
    const missing = join(staging, 'Missing.app');
    const log = join(root, 'install.log');

    await runScript([script, '999999', target, missing, staging, '0', log]);

    expect(readFileSync(join(target, 'version'), 'utf8')).toBe('old');
    expect(readFileSync(log, 'utf8')).toContain('restored the old one');
  });
});
