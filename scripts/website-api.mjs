#!/usr/bin/env node
/**
 * Runs the website API's .NET commands from `apps/website/api`, where its `global.json` pins the
 * SDK and the Microsoft.Testing.Platform runner. Running them from the repository root would pick
 * a different SDK and test runner, so the root scripts go through here.
 *
 *   node scripts/website-api.mjs build | test | format | format:check
 *
 * `test` runs the unit and the integration tests. The integration tests start PostgreSQL in
 * Docker and fail with a clear message when Docker is not running.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = join(repoRoot, 'apps', 'website', 'api');
const solution = 'Runova.Website.slnx';

function dotnet(args) {
  const result = spawnSync('dotnet', args, { cwd: apiRoot, stdio: 'inherit' });
  if (result.error) {
    console.error(`Could not run dotnet: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const commands = {
  build: () => dotnet(['build', solution, '--configuration', 'Release']),
  test: () => dotnet(['test', '--solution', solution]),
  format: () => dotnet(['format', solution]),
  'format:check': () => dotnet(['format', solution, '--verify-no-changes']),
};

const name = process.argv[2];
const command = name ? commands[name] : undefined;
if (!command) {
  console.error(`Usage: node scripts/website-api.mjs <${Object.keys(commands).join(' | ')}>`);
  process.exit(2);
}
command();
