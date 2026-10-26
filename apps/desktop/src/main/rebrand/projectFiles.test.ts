import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moveLegacyProjectFolder } from './projectFiles';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'runova-project-files-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('moveLegacyProjectFolder', () => {
  it("renames a project's folder from before the rename, with everything in it", async () => {
    mkdirSync(join(folder, '.agentmate', 'hooks'), { recursive: true }); // legacy-name
    writeFileSync(join(folder, '.agentmate', 'TASKS.md'), '# Tasks'); // legacy-name

    expect(await moveLegacyProjectFolder(folder)).toBe(true);

    expect(readFileSync(join(folder, '.runova', 'TASKS.md'), 'utf-8')).toBe('# Tasks');
    expect(existsSync(join(folder, '.runova', 'hooks'))).toBe(true);
    expect(existsSync(join(folder, '.agentmate'))).toBe(false); // legacy-name
  });

  it('never merges into a .runova folder that is already there', async () => {
    mkdirSync(join(folder, '.agentmate'), { recursive: true }); // legacy-name
    mkdirSync(join(folder, '.runova'), { recursive: true });

    expect(await moveLegacyProjectFolder(folder)).toBe(false);

    expect(existsSync(join(folder, '.agentmate'))).toBe(true); // legacy-name
  });

  it('does nothing for a project without one, or without a folder', async () => {
    expect(await moveLegacyProjectFolder(folder)).toBe(false);
    expect(await moveLegacyProjectFolder('  ')).toBe(false);
  });
});
