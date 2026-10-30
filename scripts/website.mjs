#!/usr/bin/env node
/**
 * Runs the website's bun scripts from `apps/website/web`. The site is outside the pnpm workspace
 * and uses bun as package manager and runtime, so the root scripts go through here.
 *
 *   node scripts/website.mjs dev | build | test | e2e
 *
 * Every command runs `bun install --frozen-lockfile` first, so a fresh clone works and a lockfile
 * that does not match package.json fails instead of being rewritten.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteRoot = join(repoRoot, 'apps', 'website', 'web');

function bun(args) {
  const result = spawnSync('bun', args, { cwd: siteRoot, stdio: 'inherit', shell: false });
  if (result.error) {
    console.error(`Could not run bun: ${result.error.message}. Install it from https://bun.sh`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const commands = {
  dev: () => bun(['run', 'dev']),
  build: () => {
    bun(['run', 'check']);
    bun(['run', 'build']);
  },
  test: () => {
    bun(['run', 'lint']);
    bun(['run', 'test']);
  },
  e2e: () => bun(['run', 'e2e']),
};

const name = process.argv[2];
const command = name ? commands[name] : undefined;
if (!command) {
  console.error(`Usage: node scripts/website.mjs <${Object.keys(commands).join(' | ')}>`);
  process.exit(2);
}
bun(['install', '--frozen-lockfile']);
command();
