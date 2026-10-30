import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const site = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('the site stays outside the pnpm workspace', () => {
  it('is not listed by pnpm ls at the repository root', () => {
    const output = execSync('pnpm ls -r --depth -1 --json', { cwd: repoRoot, encoding: 'utf8' });
    const packages: { name?: string; path: string }[] = JSON.parse(output);
    expect(packages.length).toBeGreaterThan(1);
    const paths = packages.map((pkg) => pkg.path.replaceAll('\\', '/'));
    expect(paths.filter((path) => path.includes('apps/website'))).toEqual([]);
    expect(packages.map((pkg) => pkg.name)).not.toContain(site.name);
  }, 60_000);
});

describe('bun runs the built server', () => {
  it('starts the Node adapter entry with bun', () => {
    expect(site.scripts.start).toBe('bun ./dist/server/entry.mjs');
  });
});
