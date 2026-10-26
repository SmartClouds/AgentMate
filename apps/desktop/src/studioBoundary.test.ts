import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Studio is built so it can leave Runova one day as its own app. Inside the desktop app that
 * comes down to two doors: main/studio/host.ts is the only main-process file that imports the
 * app's own modules, and components/studio/kit.ts (plus client.ts for the bridge) is the only
 * renderer file that does. Everything else under those folders talks to the package, to its own
 * folder, or to libraries. A split later is then a matter of rewriting the two doors.
 */

const SRC = __dirname;
const MAIN_STUDIO = join(SRC, 'main', 'studio');
const UI_STUDIO = join(SRC, 'renderer', 'src', 'components', 'studio');
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

export interface SourceFile {
  /** Relative to the folder whose rules apply, with forward slashes. */
  path: string;
  text: string;
}

function filesUnder(dir: string, base = dir): SourceFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, base);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [{ path: relative(base, full).split(sep).join('/'), text: readFileSync(full, 'utf8') }];
  });
}

const importsOf = (text: string) => [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? '');

/** A relative import that stays inside the folder the file belongs to. */
function staysInside(file: string, spec: string): boolean {
  if (!spec.startsWith('.')) return false;
  const depth = file.split('/').length - 1;
  const ups = spec.split('/').filter((part) => part === '..').length;
  return ups <= depth;
}

const MAIN_ALLOWED =
  /^(@runova\/studio(\/node)?|@runova\/core|electron|better-sqlite3|zod|node:.+)$/;
const UI_ALLOWED =
  /^(@runova\/studio|@runova\/core|react|react-dom|react-router-dom|@tanstack\/react-query|zustand|framer-motion|zod)$/;

export function mainViolations(files: SourceFile[]): string[] {
  return files.flatMap((file) =>
    file.path === 'host.ts'
      ? []
      : importsOf(file.text)
          .filter((spec) => !MAIN_ALLOWED.test(spec) && !staysInside(file.path, spec))
          .map((spec) => `main/studio/${file.path} imports ${spec}`),
  );
}

export function uiViolations(files: SourceFile[]): string[] {
  return files.flatMap((file) => {
    if (file.path === 'kit.ts') return [];
    const found = importsOf(file.text)
      .filter((spec) => !UI_ALLOWED.test(spec) && !staysInside(file.path, spec))
      .map((spec) => `components/studio/${file.path} imports ${spec}`);
    if (file.path !== 'client.ts' && /window\.runova\b/.test(file.text)) {
      found.push(`components/studio/${file.path} uses window.runova (go through client.ts)`);
    }
    return found;
  });
}

describe('Studio module boundary', () => {
  it('keeps main/studio talking to the app only through host.ts', () => {
    expect(mainViolations(filesUnder(MAIN_STUDIO))).toEqual([]);
  });

  it('keeps components/studio talking to the app only through kit.ts and client.ts', () => {
    expect(uiViolations(filesUnder(UI_STUDIO))).toEqual([]);
  });

  it('catches the imports it is there to stop', () => {
    expect(
      mainViolations([
        { path: 'host.ts', text: "import { store } from '../store';" },
        {
          path: 'capture.ts',
          text: "import { store } from '../store';\nimport { x } from './db';",
        },
      ]),
    ).toEqual(['main/studio/capture.ts imports ../store']);
    expect(
      uiViolations([
        { path: 'kit.ts', text: "export { Button } from '@/components/ui/button';" },
        {
          path: 'home/Home.tsx',
          text: "import { Button } from '@/components/ui/button';\nimport { kit } from '../kit';",
        },
        { path: 'editor/Panel.tsx', text: 'const v = window.runova.studio.list();' },
        { path: 'client.ts', text: 'export const studio = () => window.runova.studio;' },
      ]),
    ).toEqual([
      'components/studio/home/Home.tsx imports @/components/ui/button',
      'components/studio/editor/Panel.tsx uses window.runova (go through client.ts)',
    ]);
  });
});
