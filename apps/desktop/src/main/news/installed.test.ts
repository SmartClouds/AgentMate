import type { InstalledCli } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { installedTools } from './installed';

/**
 * What the matcher compares against: only what the app already detects, so the news feature runs
 * no commands of its own (E42, the table under "Affects your system").
 */

function cli(id: string, version: string | null, installed = true): InstalledCli {
  return {
    id,
    installed,
    version,
    executablePath: null,
    lastCheckedAt: '2026-10-31T00:00:00.000Z',
  };
}

const base = {
  appVersion: '3.0.0',
  electronVersion: '43.3.0',
  nodeVersion: '24.1.0',
  devSetup: {},
  clis: null,
};

describe('installedTools', () => {
  it('always has Runova, the Electron inside it and its Node.js', () => {
    expect(installedTools(base)).toEqual([
      { slug: 'runova', version: '3.0.0', label: 'Runova' },
      { slug: 'electron', version: '43.3.0', label: 'Electron (inside Runova)' },
      { slug: 'nodejs', version: '24.1.0', label: 'Node.js (inside Runova)' },
    ]);
  });

  it('puts the installed Node.js ahead of the one inside Runova', () => {
    const tools = installedTools({
      ...base,
      devSetup: { node: { state: 'found', version: '22.11.0', path: null, onPath: true } },
    });
    expect(tools.filter((tool) => tool.slug === 'nodejs')).toEqual([
      { slug: 'nodejs', version: '22.11.0', label: 'Node.js' },
      { slug: 'nodejs', version: '24.1.0', label: 'Node.js (inside Runova)' },
    ]);
  });

  it('reads Git, .NET and Docker from Dev Setup by their item ids', () => {
    const tools = installedTools({
      ...base,
      devSetup: {
        git: { state: 'found', version: '2.47.0.windows.1', path: null, onPath: true },
        'dotnet-sdk': { state: 'found', version: '10.0.100', path: null, onPath: true },
        'docker-desktop': { state: 'found', version: '28.1.1', path: null, onPath: true },
      },
    });
    expect(tools.slice(3)).toEqual([
      { slug: 'git', version: '2.47.0.windows.1', label: 'Git' },
      { slug: 'dotnet', version: '10.0.100', label: '.NET SDK' },
      { slug: 'docker', version: '28.1.1', label: 'Docker' },
    ]);
  });

  it('leaves out what is absent, failed or has no version', () => {
    const tools = installedTools({
      ...base,
      devSetup: {
        git: { state: 'absent' },
        'dotnet-sdk': { state: 'error', message: 'boom' },
        'docker-desktop': { state: 'found', version: null, path: null, onPath: true },
      },
      clis: [cli('claude-code', null), cli('codex-cli', '0.50.0', false)],
    });
    expect(tools.map((tool) => tool.slug)).toEqual(['runova', 'electron', 'nodejs']);
  });

  it('names an AI CLI by its display name and matches it by its registry id', () => {
    const tools = installedTools({ ...base, clis: [cli('claude-code', '2.1.0')] });
    expect(tools.at(-1)).toEqual({
      slug: 'claude-code',
      version: '2.1.0',
      label: 'Claude Code CLI',
    });
  });

  it('skips a CLI id that is not a technology slug', () => {
    const tools = installedTools({ ...base, clis: [cli('not-a-cli', '1.0.0')] });
    expect(tools).toHaveLength(3);
  });
});
