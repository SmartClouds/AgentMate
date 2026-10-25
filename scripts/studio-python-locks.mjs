#!/usr/bin/env node
// Writes the pinned Python environments Studio installs from Dev Setup (E37): for each engine and
// platform, the Python build and every wheel, with its address, size and SHA-256. The app then
// downloads exactly these files (resumably, so a dropping connection loses nothing) and installs
// them offline with `pip --require-hashes`, so what runs is what was locked here.
//
// Needs uv (`UV=path/to/uv` or uv on PATH) and the GitHub CLI for the Python builds. Run it again
// to move to newer versions; the output is reviewed and committed like any other change.
//
//   node scripts/studio-python-locks.mjs [piper|omnivoice ...]

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages', 'studio', 'assets', 'tools', 'locks');
const UV = process.env.UV || 'uv';
const PYTHON = '3.12';

/** Where each lock runs: uv's platform name and the Python build's target triple. */
const PLATFORMS = {
  'win-x64': { uv: 'x86_64-pc-windows-msvc', triple: 'x86_64-pc-windows-msvc' },
  'linux-x64': { uv: 'x86_64-manylinux_2_28', triple: 'x86_64-unknown-linux-gnu' },
  'linux-arm64': { uv: 'aarch64-manylinux_2_28', triple: 'aarch64-unknown-linux-gnu' },
  'macos-arm64': { uv: 'aarch64-apple-darwin', triple: 'aarch64-apple-darwin' },
  'macos-x64': { uv: 'x86_64-apple-darwin', triple: 'x86_64-apple-darwin' },
};

const TORCH = ['torch==2.8.0', 'torchaudio==2.8.0'];
const ENVS = {
  piper: {
    requirements: ['piper-tts==1.8.0'],
    module: 'piper',
    targets: Object.keys(PLATFORMS).map((platform) => ({ platform, accelerator: 'cpu' })),
  },
  omnivoice: {
    requirements: [...TORCH, 'omnivoice==0.2.1'],
    module: 'omnivoice',
    targets: [
      { platform: 'win-x64', accelerator: 'cu128' },
      { platform: 'win-x64', accelerator: 'cpu' },
      { platform: 'linux-x64', accelerator: 'cu128' },
      { platform: 'linux-x64', accelerator: 'cpu' },
      // Apple's GPU is reached through the ordinary torch build.
      { platform: 'macos-arm64', accelerator: 'mps' },
    ],
  },
};

/** PyTorch's own index for a CUDA or CPU build; none on macOS, where PyPI's build is the one. */
function torchIndex(accelerator) {
  if (accelerator === 'cu128') return 'https://download.pytorch.org/whl/cu128';
  if (accelerator === 'cpu') return 'https://download.pytorch.org/whl/cpu';
  return null;
}

/** The newest Python 3.12 build for each target triple, from python-build-standalone. */
function pythonBuilds() {
  const release = JSON.parse(
    execFileSync('gh', ['api', 'repos/astral-sh/python-build-standalone/releases/latest'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const builds = {};
  const pattern = /^cpython-(3\.12\.\d+)\+(\d+)-(.+)-install_only\.tar\.gz$/;
  for (const asset of release.assets) {
    const match = pattern.exec(asset.name);
    if (!match || !asset.digest?.startsWith('sha256:')) continue;
    builds[match[3]] = {
      version: match[1],
      url: asset.browser_download_url,
      size: asset.size,
      sha256: asset.digest.slice('sha256:'.length),
    };
  }
  return builds;
}

/**
 * The packages of a pylock.toml as uv writes it: one `[[packages]]` table each, with `name`,
 * `version` and `wheels` (already narrowed to the target platform). Only the fields used here.
 */
export function readPylock(text) {
  const packages = [];
  for (const block of text.split(/^\[\[packages\]\]$/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    const wheels = [
      ...block.matchAll(
        /\{ url = "([^"]+\.whl)"[^}]*?(?:size = (\d+), )?hashes = \{ sha256 = "([0-9a-f]{64})" \} \}/g,
      ),
    ].map((m) => ({ url: m[1], size: m[2] ? Number(m[2]) : null, sha256: m[3] }));
    if (!name || !version) continue;
    if (wheels.length === 0) throw new Error(`${name} ${version} has no wheel for this platform.`);
    // The platform's own build when there is one, else the pure Python one.
    const wheel = wheels.find((w) => !/-none-any\.whl$/.test(w.url)) ?? wheels[0];
    packages.push({
      name,
      version,
      file: decodeURIComponent(wheel.url.split('/').pop()),
      ...wheel,
    });
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/** uv leaves a wheel's size out when its index did not say; the file server says instead. */
async function withSizes(packages) {
  for (const p of packages) {
    if (p.size !== null) continue;
    const response = await fetch(p.url, { method: 'HEAD' });
    const length = Number(response.headers.get('content-length'));
    if (!response.ok || !length) throw new Error(`Could not find the size of ${p.file}.`);
    p.size = length;
  }
  return packages;
}

async function compile(env, target) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-lock-'));
  try {
    const input = join(dir, 'requirements.in');
    writeFileSync(input, `${ENVS[env].requirements.join('\n')}\n`);
    const output = join(dir, 'pylock.studio.toml');
    const args = [
      'pip',
      'compile',
      input,
      '--python-version',
      PYTHON,
      '--python-platform',
      PLATFORMS[target.platform].uv,
      '--format',
      'pylock.toml',
      '--no-header',
      '-o',
      output,
    ];
    const index = torchIndex(target.accelerator);
    if (index) args.push('--extra-index-url', index, '--index-strategy', 'unsafe-best-match');
    execFileSync(UV, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    return await withSizes(readPylock(readFileSync(output, 'utf8')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const wanted = process.argv.slice(2);
  const envs = wanted.length > 0 ? wanted : Object.keys(ENVS);
  const builds = pythonBuilds();
  mkdirSync(OUT, { recursive: true });
  for (const env of envs) {
    if (!ENVS[env]) throw new Error(`No environment called ${env}.`);
    for (const target of ENVS[env].targets) {
      const python = builds[PLATFORMS[target.platform].triple];
      if (!python) throw new Error(`No Python ${PYTHON} build for ${target.platform}.`);
      const packages = await compile(env, target);
      const lock = {
        lockVersion: 1,
        env,
        platform: target.platform,
        accelerator: target.accelerator,
        module: ENVS[env].module,
        requirements: ENVS[env].requirements,
        python,
        packages,
      };
      const name = `${env}-${target.platform}-${target.accelerator}.json`;
      writeFileSync(join(OUT, name), `${JSON.stringify(lock, null, 2)}\n`);
      const bytes = packages.reduce((sum, p) => sum + p.size, python.size);
      console.log(`${name}: ${packages.length} packages, ${(bytes / 1024 ** 2).toFixed(0)} MB`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
