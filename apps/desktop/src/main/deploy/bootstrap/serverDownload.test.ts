import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { quoteForShell } from '@agentmat/core';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/main/fixtures';
import { CHECKSUM_MISMATCH_EXIT } from './installPlan';
import { downloadCommand, parseProbe, probeCommand } from './serverDownload';

/**
 * Letting the server fetch the core itself: the probe says whether it can and with what, and the
 * download saves the release into the login user's staging folder, checked against its published
 * checksum. Neither ever names anything but a release asset of the right shape.
 */

const FILE = 'agentmate-core-1.53.0-linux-x64.tar.gz';
const URL = `https://github.com/SmartClouds/AgentMate/releases/download/v1.53.0/${FILE}`;
const BODY = 'tarball bytes';
const SHA = createHash('sha256').update(BODY).digest('hex');

const q = (value: string): string => quoteForShell(value, 'posix');

/** The script inside `sh -c '<script>'`, as the shell sees it. */
function scriptOf(command: string): string {
  const quoted = /^sh -c (.*)$/s.exec(command)?.[1] ?? '';
  return quoted.startsWith("'") ? quoted.slice(1, -1).replace(/'\\''/g, "'") : quoted;
}

describe('probeCommand', () => {
  it('asks for the exact release, with curl first and wget as the other way', () => {
    const script = scriptOf(probeCommand(URL));

    expect(script.indexOf('command -v curl')).toBeLessThan(script.indexOf('command -v wget'));
    expect(script).toContain('curl -fsSIL');
    expect(script).toContain('wget -q --spider');
    expect(script.split(q(URL))).toHaveLength(3);
  });

  it('does not download any of it', () => {
    expect(scriptOf(probeCommand(URL))).toContain('-o /dev/null');
  });

  it.each([
    'https://example.com/agentmate-core-1.53.0-linux-x64.tar.gz',
    'http://github.com/SmartClouds/AgentMate/releases/download/v1.53.0/agentmate-core-1.53.0-linux-x64.tar.gz',
    `${URL}; rm -rf /`,
    `${URL}' && echo pwned '`,
    'https://github.com/SmartClouds/AgentMate/releases/download/v1.53.0/other.tar.gz',
    'https://github.com/SmartClouds/AgentMate/releases/download/v1.53.0/agentmate-core-1.53.0-windows-x64.tar.gz',
  ])('refuses an address that is not a server core release: %s', (address) => {
    expect(() => probeCommand(address)).toThrow(/not a server core release address/);
  });
});

describe('parseProbe', () => {
  it.each([
    ['curl\n', 'curl'],
    ['wget\n', 'wget'],
    ['  curl  ', 'curl'],
    ['warning: something\ncurl\n', 'curl'],
  ] as const)('reads %j as %s', (stdout, tool) => {
    expect(parseProbe(stdout)).toBe(tool);
  });

  it.each(['', '\n', 'nothing', 'curl is missing', 'wgetx'])('reads %j as no tool', (stdout) => {
    expect(parseProbe(stdout)).toBeNull();
  });
});

describe('downloadCommand', () => {
  const input = {
    tool: 'curl',
    url: URL,
    directory: '/tmp/agentmate.Test123456',
    file: FILE,
    sha256: SHA,
  } as const;

  const saved = q(`/tmp/agentmate.Test123456/${FILE}`);

  it('saves the release in the staging folder and checks its checksum there', () => {
    const script = scriptOf(downloadCommand(input));

    expect(script).toContain(`-o ${saved} ${q(URL)}`);
    expect(script).toContain(`cd ${q('/tmp/agentmate.Test123456')}`);
    expect(script).toContain(`${SHA} ${q(FILE)}`);
    expect(script).toContain('sha256sum -c --status');
    expect(script).toContain(`(exit ${CHECKSUM_MISMATCH_EXIT})`);
  });

  it('leaves nothing behind when the download fails or does not match', () => {
    expect(scriptOf(downloadCommand(input))).toContain(`rm -f -- ${saved}`);
  });

  it('keeps the file private to the login user', () => {
    expect(scriptOf(downloadCommand(input))).toMatch(/^umask 077;/);
  });

  it('uses wget where that is all the server has', () => {
    const script = scriptOf(downloadCommand({ ...input, tool: 'wget' }));

    expect(script).toContain(`wget -q --tries=3 --timeout=30 -O ${saved} ${q(URL)}`);
    expect(script).not.toContain('curl');
  });

  it('refuses a file that is not the one the address points at', () => {
    expect(() =>
      downloadCommand({ ...input, file: 'agentmate-core-1.0.0-linux-x64.tar.gz' }),
    ).toThrow(/does not point at/);
  });

  it('refuses a checksum that is not a SHA-256', () => {
    expect(() => downloadCommand({ ...input, sha256: 'abc' })).toThrow(/not a SHA-256/);
  });

  it('refuses an address that is not a release', () => {
    expect(() => downloadCommand({ ...input, url: 'https://example.com/x.tar.gz' })).toThrow(
      /not a server core release address/,
    );
  });
});

const hasShell =
  spawnSync('sh', ['-c', 'command -v sha256sum >/dev/null && command -v printf >/dev/null'])
    .status === 0;

/**
 * The command in a real shell, with a stand-in `curl` or `wget` first on the path: it saves what
 * `FAKE_BODY` says, or fails with `FAKE_FAIL` and `FAKE_EXIT`.
 */
describe.skipIf(!hasShell)('downloadCommand in a shell', () => {
  function run(tool: 'curl' | 'wget', env: Record<string, string>) {
    const root = tempDir();
    const bin = join(root, 'bin').replaceAll('\\', '/');
    const directory = join(root, 'staging').replaceAll('\\', '/');
    mkdirSync(bin);
    mkdirSync(directory);
    writeFileSync(
      join(bin, tool),
      [
        '#!/bin/sh',
        'out=""',
        'while [ $# -gt 0 ]; do',
        '  case "$1" in -o|-O) out="$2"; shift ;; esac',
        '  shift',
        'done',
        '[ -z "$FAKE_FAIL" ] || { echo "$FAKE_FAIL" >&2; exit "${FAKE_EXIT:-22}"; }',
        'printf %s "$FAKE_BODY" > "$out"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const command = downloadCommand({ tool, url: URL, directory, file: FILE, sha256: SHA });
    const result = spawnSync('sh', ['-c', command], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
      encoding: 'utf-8',
    });
    return { result, saved: join(directory, FILE) };
  }

  it.each(['curl', 'wget'] as const)('saves a matching download with %s', (tool) => {
    const { result, saved } = run(tool, { FAKE_BODY: BODY });

    expect(result.status).toBe(0);
    expect(readFileSync(saved, 'utf-8')).toBe(BODY);
  });

  it('exits with the mismatch code and removes what it got when the checksum is wrong', () => {
    const { result, saved } = run('curl', { FAKE_BODY: '<html>sign in to the Wi-Fi</html>' });

    expect(result.status).toBe(CHECKSUM_MISMATCH_EXIT);
    expect(existsSync(saved)).toBe(false);
  });

  it('passes on the tool exit code and its words when the download fails', () => {
    const { result, saved } = run('curl', {
      FAKE_FAIL: 'curl: (6) Could not resolve host: github.com',
      FAKE_EXIT: '6',
    });

    expect(result.status).toBe(6);
    expect(result.stderr).toContain('Could not resolve host');
    expect(existsSync(saved)).toBe(false);
  });
});
