import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Studio is built to leave AgentMate one day as its own app. These checks keep it able to:
 * nothing in the package reaches for Electron, React or the app's native SQLite build, and the
 * root export (which the renderer imports) never pulls in Node-only code.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function importsOf(text: string): string[] {
  return [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? '');
}

/** The specifiers that break the rules for the root export, found by walking from `entry`. */
export function rootExportViolations(entry: string, read: (file: string) => string): string[] {
  const seen = new Set<string>();
  const violations: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importsOf(read(file))) {
      if (spec.startsWith('node:')) violations.push(`${relative(SRC, file)} imports ${spec}`);
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      if (relative(SRC, target).startsWith(`node`))
        violations.push(`${relative(SRC, file)} imports ${spec}`);
      visit(target);
    }
  };
  visit(entry);
  return violations;
}

const production = sourceFiles(SRC).filter(
  (f) => !f.endsWith('.test.ts') && !f.includes(`${join('src', 'test')}`),
);

describe('Studio package boundary', () => {
  it('never imports Electron, React or better-sqlite3', () => {
    const offenders = production.flatMap((file) =>
      importsOf(readFileSync(file, 'utf8'))
        .filter((spec) => /^(electron|react|react-dom|better-sqlite3)(\/|$)/.test(spec))
        .map((spec) => `${relative(SRC, file)} imports ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps Node-only code out of the root export the renderer uses', () => {
    expect(rootExportViolations(join(SRC, 'index.ts'), (f) => readFileSync(f, 'utf8'))).toEqual([]);
  });

  it('catches a root export that reaches Node code, so the check above can fail', () => {
    const files: Record<string, string> = {
      [join(SRC, 'index.ts')]: "export * from './a.js';",
      [join(SRC, 'a.ts')]: "import { x } from './node/service.js';\nimport { y } from 'node:fs';",
      [join(SRC, 'node', 'service.ts')]: '',
    };
    expect(rootExportViolations(join(SRC, 'index.ts'), (f) => files[f] ?? '')).toEqual([
      'a.ts imports ./node/service.js',
      'a.ts imports node:fs',
    ]);
  });
});
