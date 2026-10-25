import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceleratorFor,
  lockBytes,
  lockFileName,
  parseNvidiaSmi,
  pythonLockSchema,
  requirementsText,
  studioPlatform,
  studioToolPaths,
} from './pythonLock.js';

const LOCKS = join(__dirname, '..', '..', 'assets', 'tools', 'locks');

describe('the committed lock files', () => {
  const files = readdirSync(LOCKS).filter((f) => f.endsWith('.json'));

  it('cover Piper on every platform and OmniVoice where it has a build, each valid', () => {
    expect(files.sort()).toEqual(
      [
        'omnivoice-linux-x64-cpu.json',
        'omnivoice-linux-x64-cu128.json',
        'omnivoice-macos-arm64-mps.json',
        'omnivoice-win-x64-cpu.json',
        'omnivoice-win-x64-cu128.json',
        'piper-linux-arm64-cpu.json',
        'piper-linux-x64-cpu.json',
        'piper-macos-arm64-cpu.json',
        'piper-macos-x64-cpu.json',
        'piper-win-x64-cpu.json',
      ].sort(),
    );
    for (const file of files) {
      const lock = pythonLockSchema.parse(JSON.parse(readFileSync(join(LOCKS, file), 'utf8')));
      expect(lockFileName(lock.env, lock.platform, lock.accelerator), file).toBe(file);
      // Wheels come from PyPI, PyTorch or NVIDIA (its CUDA libraries), Python from its standalone
      // builds; never anywhere else.
      for (const p of lock.packages) {
        expect(new URL(p.url).hostname, p.file).toMatch(
          /^(files\.pythonhosted\.org|download\.pytorch\.org|download-r2\.pytorch\.org|pypi\.nvidia\.com)$/,
        );
        expect(decodeURIComponent(p.url).endsWith(p.file), p.file).toBe(true);
      }
      expect(lock.python.url).toMatch(
        /^https:\/\/github\.com\/astral-sh\/python-build-standalone\//,
      );
      // One copy of each package, so pip never meets two answers.
      expect(new Set(lock.packages.map((p) => p.name.toLowerCase())).size, file).toBe(
        lock.packages.length,
      );
    }
  });

  it('pins the engines themselves and a CUDA PyTorch for NVIDIA cards', () => {
    const read = (name: string) =>
      pythonLockSchema.parse(JSON.parse(readFileSync(join(LOCKS, name), 'utf8')));
    const piper = read('piper-win-x64-cpu.json');
    expect(piper.packages.find((p) => p.name === 'piper-tts')?.version).toBe('1.8.0');
    const cuda = read('omnivoice-win-x64-cu128.json');
    expect(cuda.packages.find((p) => p.name === 'torch')?.version).toBe('2.8.0+cu128');
    expect(cuda.packages.find((p) => p.name === 'omnivoice')).toBeDefined();
    expect(lockBytes(cuda)).toBeGreaterThan(3_000_000_000);
    expect(requirementsText(piper).split('\n')[0]).toMatch(
      /^[a-z-]+==[^ ]+ --hash=sha256:[0-9a-f]{64}$/,
    );
  });
});

describe('choosing a build', () => {
  const card = (driver: string) => ({ name: 'NVIDIA GeForce RTX 3050', driver, memoryMiB: 4096 });

  it('maps the computer to a platform', () => {
    expect(studioPlatform('win32', 'x64')).toBe('win-x64');
    expect(studioPlatform('darwin', 'arm64')).toBe('macos-arm64');
    expect(studioPlatform('linux', 'arm64')).toBe('linux-arm64');
    expect(studioPlatform('win32', 'arm64')).toBeNull();
  });

  it('runs Piper on the processor, OmniVoice on a new enough NVIDIA card or Apple silicon', () => {
    expect(acceleratorFor('piper', 'win-x64', card('610.88'))).toBe('cpu');
    expect(acceleratorFor('omnivoice', 'win-x64', card('610.88'))).toBe('cu128');
    expect(acceleratorFor('omnivoice', 'linux-x64', card('550.120'))).toBe('cpu');
    expect(acceleratorFor('omnivoice', 'win-x64', null)).toBe('cpu');
    expect(acceleratorFor('omnivoice', 'macos-arm64', null)).toBe('mps');
    expect(acceleratorFor('omnivoice', 'macos-x64', null)).toBeNull();
    expect(acceleratorFor('omnivoice', 'linux-arm64', null)).toBeNull();
  });

  it('reads nvidia-smi, and nothing from a machine without it', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3050 Laptop GPU, 610.88, 4096\r\n')).toEqual({
      name: 'NVIDIA GeForce RTX 3050 Laptop GPU',
      driver: '610.88',
      memoryMiB: 4096,
    });
    expect(parseNvidiaSmi('')).toBeNull();
    expect(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate')).toBeNull();
  });
});

describe('where tools live', () => {
  it('lays out environments, Python builds and models on Windows and elsewhere', () => {
    const win = studioToolPaths(
      'C:\\Users\\me\\AppData\\Roaming\\AgentMate\\studio-tools',
      'win32',
    );
    expect(win.envPython('piper')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\AgentMate\\studio-tools\\envs\\piper\\Scripts\\python.exe',
    );
    expect(win.basePython(win.pythonDir('3.12.15', 'win-x64'))).toMatch(
      /\\python\\3\.12\.15-win-x64\\python\.exe$/,
    );
    const mac = studioToolPaths('/Users/me/Library/AgentMate/studio-tools', 'darwin');
    expect(mac.envPython('omnivoice')).toBe(
      '/Users/me/Library/AgentMate/studio-tools/envs/omnivoice/bin/python3',
    );
    expect(mac.modelsDir('piper-voices')).toBe(
      '/Users/me/Library/AgentMate/studio-tools/models/piper-voices',
    );
    expect(mac.marker('piper')).toBe(
      '/Users/me/Library/AgentMate/studio-tools/piper.installed.json',
    );
  });
});
