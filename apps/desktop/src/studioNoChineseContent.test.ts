import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Runova ships no Chinese content, and Studio is where it could slip in: style presets and
 * reference scenes, provider voice lists, prompts, help text. This scans every Studio source and
 * asset for Han characters and Chinese language tags.
 */

const REPO = resolve(__dirname, '..', '..', '..');
const ROOTS = [
  'packages/studio/src',
  'packages/studio/assets',
  'apps/desktop/src/main/studio',
  'apps/desktop/src/renderer/src/components/studio',
  'apps/desktop/src/preload/studio.ts',
  'apps/desktop/src/main/ipc/studio.ts',
  'apps/desktop/src/shared/help/articles/studio.md',
  'apps/desktop/resources/studio',
];
const TEXT = /\.(ts|tsx|js|mjs|json|md|html|css|svg|txt|py)$/;
const HAN = /\p{Script=Han}/u;
// A language tag in a string, such as 'zh-CN' or "cmn". Word boundaries keep "zhang" out.
const CHINESE_TAG = /['"](zh|cmn|yue)(-[A-Za-z]{2,4})*['"]/;

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

export function chineseContentIn(name: string, text: string): string[] {
  const found: string[] = [];
  text.split('\n').forEach((line, index) => {
    if (HAN.test(line)) found.push(`${name}:${index + 1} has Han characters`);
    else if (CHINESE_TAG.test(line)) found.push(`${name}:${index + 1} names a Chinese language`);
  });
  return found;
}

describe('no Chinese content in Studio', () => {
  it('finds none in any Studio source or asset', () => {
    const offenders = ROOTS.flatMap((root) => files(join(REPO, root)))
      .filter((file) => TEXT.test(file))
      // The language filter has to name the codes it filters, and its test proves it works.
      .filter((file) => !/[\\/]text[\\/]languages(\.test)?\.ts$/.test(file))
      .flatMap((file) => chineseContentIn(relative(REPO, file), readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('catches Han characters and Chinese language tags, so the scan above can fail', () => {
    const han = String.fromCodePoint(0x4e2d, 0x6587);
    expect(
      chineseContentIn('a.ts', `const title = '${han}';\nconst lang = 'zh-CN';\nconst ok = 'fa';`),
    ).toEqual(['a.ts:1 has Han characters', 'a.ts:2 names a Chinese language']);
  });
});
