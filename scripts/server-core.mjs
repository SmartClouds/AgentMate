#!/usr/bin/env node
/**
 * Runs the server core's .NET commands from `apps/server-core`, where its `global.json` pins the
 * SDK and the Microsoft.Testing.Platform runner. Running them from the repository root would pick
 * a different SDK and test runner, so the root scripts go through here.
 *
 *   node scripts/server-core.mjs build | test | format | format:check | contracts
 *   node scripts/server-core.mjs publish linux-x64 | linux-arm64
 *
 * `contracts` regenerates the TypeScript types and typed hub client (Tapper and
 * TypedSignalR.Client.TypeScript) into the desktop's shared folder, from a clean slate so a C#
 * type that was removed cannot leave a stale file behind.
 *
 * `publish` builds one release tarball: the self-contained binary, the native libraries beside
 * it and the systemd unit, as `artifacts/release/runova-core-<version>-<rid>.tar.gz`, with its
 * SHA-256 in a `.sha256` file and in `server-core-manifest.json`, which the desktop embeds to
 * verify what it installs. The version comes from SERVER_CORE_VERSION (0.0.0-dev otherwise).
 *
 * Servers set up before the rename (release 1.63 and older) update themselves by the old names,
 * so the tarball also holds the program under its old name (a hard link) and the old unit file,
 * and the same bytes are published a second time under the old tarball name. The manifest lists
 * that name as each asset's `legacyFile`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = join(repoRoot, 'apps', 'server-core');
const solution = 'Runova.ServerCore.slnx';
const hostProject = join('src', 'Runova.ServerCore', 'Runova.ServerCore.csproj');
const contractsOutput = join(
  repoRoot,
  'apps',
  'desktop',
  'src',
  'shared',
  'deploy',
  'protocol',
  'generated',
);

function run(command, args, cwd = coreRoot) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const dotnet = (args) => run('dotnet', args);

const RIDS = new Set(['linux-x64', 'linux-arm64']);

// The names a server from before the rename knows. Published until 1.63 servers are gone.
const LEGACY_BINARY = 'agentmate-core'; // legacy-name
const LEGACY_UNIT = 'agentmate-core.service'; // legacy-name
const LEGACY_TARBALL_PREFIX = 'agentmate-core-'; // legacy-name

function publish(rid) {
  if (!RIDS.has(rid)) {
    console.error(`Usage: node scripts/server-core.mjs publish <${[...RIDS].join(' | ')}>`);
    process.exit(2);
  }
  const version = process.env.SERVER_CORE_VERSION || '0.0.0-dev';
  const publishDir = join(coreRoot, 'artifacts', 'publish', rid);
  const releaseDir = join(coreRoot, 'artifacts', 'release');
  rmSync(publishDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });

  dotnet([
    'publish',
    hostProject,
    '--configuration',
    'Release',
    '--runtime',
    rid,
    '--output',
    publishDir,
    `-p:Version=${version}`,
  ]);
  copyFileSync(
    join(coreRoot, 'packaging', 'runova-core.service'),
    join(publishDir, 'runova-core.service'),
  );
  copyFileSync(join(coreRoot, 'packaging', 'legacy', LEGACY_UNIT), join(publishDir, LEGACY_UNIT));
  // One program, two names: the old core's updater looks for the old one.
  linkSync(join(publishDir, 'runova-core'), join(publishDir, LEGACY_BINARY));

  const file = `runova-core-${version}-${rid}.tar.gz`;
  const legacyFile = `${LEGACY_TARBALL_PREFIX}${version}-${rid}.tar.gz`;
  const tarball = join(releaseDir, file);
  const legacyTarball = join(releaseDir, legacyFile);
  rmSync(tarball, { force: true });
  rmSync(legacyTarball, { force: true });
  // Relative paths only: GNU tar on Windows takes "C:" in an archive name for a remote host.
  run('tar', ['-czf', join('..', '..', 'release', file), '.'], publishDir);
  copyFileSync(tarball, legacyTarball);

  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  writeFileSync(`${tarball}.sha256`, `${sha256}  ${file}\n`);
  writeFileSync(`${legacyTarball}.sha256`, `${sha256}  ${legacyFile}\n`);

  const manifestPath = join(releaseDir, 'server-core-manifest.json');
  const previous = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf-8'))
    : null;
  const assets = previous?.version === version ? previous.assets.filter((a) => a.rid !== rid) : [];
  assets.push({ rid, file, legacyFile, sha256, size: statSync(tarball).size });
  assets.sort((a, b) => a.rid.localeCompare(b.rid));
  writeFileSync(manifestPath, `${JSON.stringify({ version, assets }, null, 2)}\n`);
  console.log(`${file} ${sha256}`);
  console.log(`${legacyFile} ${sha256}`);
}

const commands = {
  publish: () => publish(process.argv[3]),
  build: () => dotnet(['build', solution]),
  test: () => dotnet(['test', '--project', join('tests', 'Runova.ServerCore.Tests')]),
  format: () => dotnet(['format', solution]),
  'format:check': () => dotnet(['format', solution, '--verify-no-changes']),
  contracts: () => {
    rmSync(contractsOutput, { recursive: true, force: true });
    dotnet(['tool', 'restore']);
    // The generator reads the project through MSBuild and only sees the attribute packages once
    // the project has been restored.
    dotnet(['restore', hostProject]);
    dotnet([
      'tsrts',
      '--project',
      hostProject,
      '--output',
      contractsOutput,
      '--enum',
      'UnionCamel',
      '--eol',
      'Lf',
    ]);
  },
};

const name = process.argv[2];
const command = name ? commands[name] : undefined;
if (!command) {
  console.error(`Usage: node scripts/server-core.mjs <${Object.keys(commands).join(' | ')}>`);
  process.exit(2);
}
command();
