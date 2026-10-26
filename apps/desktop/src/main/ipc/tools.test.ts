import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_TOOL_REGISTRY,
  getToolUninstallCommandForCurrentOS,
  getToolUpdateCommandForCurrentOS,
  type SupportedOS,
} from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { tempDir, withPlatform, writeTree } from '../../test/main/fixtures';
import { invoke, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

/**
 * The Agent Tools card's update and uninstall buttons. The catalog installs most tools with the
 * vendor's script now, but an old `npm install -g` copy is still what runs on many machines, and
 * the vendor's script would leave that copy in place. These pin that the command typed into the
 * terminal goes to npm in that case, and is the catalog's own otherwise.
 *
 * Detection is not run here (it probes every tool and Docker); the handlers look the executable
 * up on demand when no detect pass has happened, and a fake npm shim on a temp PATH stands in.
 */

vi.mock('../toolPaths', () => ({
  getExtraToolPathDirs: async () => [],
  pythonScriptDirs: async () => [],
  refreshExtraToolPathDirs: vi.fn(),
  withToolPath: async (env?: NodeJS.ProcessEnv) => ({ ...(env ?? process.env) }),
}));

useTempUserData();

let binDir = '';
const platform = process.platform as SupportedOS;
const INSTALLER = /^(curl|wget|irm|iwr|powershell|pwsh)\b/i;
const REMOVAL = /^(rm|remove-item|del|rd|rmdir|curl|wget|irm|iwr|powershell|pwsh)\b/i;

beforeEach(async () => {
  binDir = join(tempDir('runova-tools-'), 'bin');
  mkdirSync(binDir, { recursive: true });
  const key = Object.keys(process.env).find((one) => one.toUpperCase() === 'PATH') ?? 'PATH';
  vi.stubEnv(key, binDir);
  await loadIpc(
    () => import('./tools'),
    (module) => module.registerToolHandlers(),
  );
});

/** What `npm install -g <pkg>` leaves in its prefix folder for `name`. */
function writeNpmShim(name: string, pkg: string): void {
  const win = process.platform === 'win32';
  writeTree(binDir, {
    [`node_modules/${pkg}/cli.js`]: '',
    [win ? `${name}.cmd` : name]: win
      ? `@echo off\r\n"%dp0%\\node_modules\\${pkg.replace('/', '\\')}\\cli.js" %*\r\n`
      : `#!/bin/sh\nexec node "$basedir/node_modules/${pkg}/cli.js" "$@"\n`,
  });
  if (!win) chmodSync(join(binDir, name), 0o755);
}

/** Every tool that ships on npm and can be found on disk, with its package and command name. */
const npmTools = AGENT_TOOL_REGISTRY.flatMap((tool) =>
  tool.updateCheck?.type === 'npm' && tool.detectCommand
    ? [{ tool, pkg: tool.updateCheck.package, command: tool.detectCommand.command }]
    : [],
);

describe('update command', () => {
  it('goes to npm for an npm copy only where the catalog would re-run the vendor script', async () => {
    // A self-updater (`openclaw update`, `codegraph upgrade; codegraph install`) already handles
    // an npm copy and may run follow-up steps, so only a script re-run is swapped out.
    expect(npmTools.length).toBeGreaterThan(0);
    for (const { pkg, command } of npmTools) writeNpmShim(command, pkg);

    for (const { tool, pkg } of npmTools) {
      const catalog = getToolUpdateCommandForCurrentOS(tool, platform);
      const expected =
        catalog === null || INSTALLER.test(catalog) ? `npm install -g ${pkg}@latest` : catalog;
      await expect(invoke(IPC.tools.getUpdateCommand, tool.id), tool.id).resolves.toBe(expected);
    }
  });

  it("is the catalog's own when the tool is not installed", async () => {
    for (const tool of AGENT_TOOL_REGISTRY) {
      await expect(invoke(IPC.tools.getUpdateCommand, tool.id), tool.id).resolves.toBe(
        getToolUpdateCommandForCurrentOS(tool, platform),
      );
    }
  });

  it('answers null for a tool it has never heard of', async () => {
    await expect(invoke(IPC.tools.getUpdateCommand, 'not-a-tool')).resolves.toBeNull();
    await expect(invoke(IPC.tools.getUninstallCommand, 'not-a-tool')).resolves.toBeNull();
  });
});

describe('uninstall command', () => {
  it('goes to npm for an npm copy only where the catalog would delete files by hand', async () => {
    for (const { pkg, command } of npmTools) writeNpmShim(command, pkg);

    for (const { tool, pkg } of npmTools) {
      const catalog = getToolUninstallCommandForCurrentOS(tool, platform);
      const expected =
        catalog === null || REMOVAL.test(catalog) ? `npm uninstall -g ${pkg}` : catalog;
      await expect(invoke(IPC.tools.getUninstallCommand, tool.id), tool.id).resolves.toBe(expected);
    }
  });
});

describe('docker reset command', () => {
  const docker = AGENT_TOOL_REGISTRY.find((tool) => tool.docker);

  it.skipIf(!docker)('joins with ; for PowerShell 5.1 on Windows, which has no &&', async () => {
    if (!docker) return;
    const onWindows = await withPlatform('win32', () =>
      invoke<string | null>(IPC.tools.getDockerCommand, docker.id, 'reset'),
    );
    const onLinux = await withPlatform('linux', () =>
      invoke<string | null>(IPC.tools.getDockerCommand, docker.id, 'reset'),
    );

    expect(onWindows).not.toContain('&&');
    expect(onWindows).toContain(';');
    expect(onLinux).toContain('&&');
  });
});
