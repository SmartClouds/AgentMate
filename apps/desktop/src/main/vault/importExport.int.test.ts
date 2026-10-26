import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KdfCost } from './kdf';
import { VaultService } from './service';
import { VaultError } from './session';
import { MemoryVaultFiles } from './testing/memoryVaultFiles';

const FAST: KdfCost = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'correct horse battery staple';

const BITWARDEN = [
  'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
  'Work,1,login,GitHub,,,0,https://github.com,octocat,S3NT1NEL-gh,',
  ',,login,GitLab,,,0,https://gitlab.com,dev,S3NT1NEL-gl,',
  ',,card,Visa,,,0,,,,',
].join('\n');

let dir = '';

async function unlockedService() {
  let clipboardText = '';
  const service = new VaultService({
    files: new MemoryVaultFiles(),
    cost: FAST,
    clipboard: { readText: () => clipboardText, writeText: (t) => (clipboardText = t) },
    events: { stateChanged: vi.fn(), entriesChanged: vi.fn(), clipboardSettled: vi.fn() },
    env: {},
    isPackaged: false,
  });
  await service.create(PASSWORD);
  return service;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runova-vault-io-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('vault import', () => {
  it('previews a detected format without sending any password', async () => {
    const service = await unlockedService();
    await service.save({
      type: 'login',
      title: 'GitHub',
      tags: [],
      favorite: false,
      username: 'octocat',
      password: 'S3NT1NEL-gh',
      urls: ['https://github.com'],
    });
    const path = join(dir, 'bitwarden_export.csv');
    await writeFile(path, BITWARDEN);

    const preview = await service.importOpen(path);
    expect(preview).toMatchObject({
      fileName: 'bitwarden_export.csv',
      format: 'bitwarden',
      rowCount: 3,
      importable: 2,
      duplicates: { identical: 1, conflict: 0 },
      skipped: [{ row: 4, reason: 'Unsupported item type "card"' }],
    });
    expect(preview.sample).toEqual([
      { type: 'login', title: 'GitHub', username: 'octocat', host: 'github.com' },
      { type: 'login', title: 'GitLab', username: 'dev', host: 'gitlab.com' },
    ]);
    expect(JSON.stringify(preview)).not.toContain('S3NT1NEL');
  });

  it('commits once with the chosen duplicate policy and forgets the file afterwards', async () => {
    const service = await unlockedService();
    const path = join(dir, 'export.csv');
    await writeFile(path, BITWARDEN);
    const { token } = await service.importOpen(path);

    const result = await service.importCommit(token, null, 'skip');
    expect(result).toEqual({
      added: 2,
      replaced: 0,
      skipped: 0,
      invalid: [{ row: 4, reason: 'Unsupported item type "card"' }],
    });
    expect(
      service
        .list()
        .map((s) => s.title)
        .sort(),
    ).toEqual(['GitHub', 'GitLab']);
    await expect(service.importCommit(token, null, 'skip')).rejects.toBeInstanceOf(VaultError);
  });

  it('remaps a generic file with the mapping the user picked', async () => {
    const service = await unlockedService();
    const path = join(dir, 'other.csv');
    await writeFile(path, 'Site;Login;Secret\nRouter;admin;S3NT1NEL-rt\n');
    const opened = await service.importOpen(path);
    expect(opened.format).toBeNull();
    expect(opened.mapping.columns).toEqual(['title', 'username', 'password']);

    const remapped = service.importPreview(opened.token, {
      columns: ['title', 'ignore', 'password'],
    });
    expect(remapped.sample).toEqual([{ type: 'login', title: 'Router', username: '', host: '' }]);
    const result = await service.importCommit(
      opened.token,
      { columns: ['title', 'ignore', 'password'] },
      'keepBoth',
    );
    expect(result.added).toBe(1);
    expect(service.reveal(service.list()[0].id, 'password')).toBe('S3NT1NEL-rt');
  });

  it('refuses files over 10 MB and forgets pending imports when the vault locks', async () => {
    const service = await unlockedService();
    const big = join(dir, 'big.csv');
    await writeFile(big, Buffer.alloc(10 * 1024 * 1024 + 1, 'a'));
    await expect(service.importOpen(big)).rejects.toThrow(/10 MB/);

    const path = join(dir, 'export.csv');
    await writeFile(path, BITWARDEN);
    const { token } = await service.importOpen(path);
    await service.lock('manual');
    await service.unlock(PASSWORD);
    await expect(service.importCommit(token, null, 'skip')).rejects.toThrow(/expired|start/i);
  });
});

describe('vault export', () => {
  it('needs the master password and writes a CSV that imports back identically', async () => {
    const service = await unlockedService();
    await service.save({
      type: 'custom',
      title: 'Router',
      tags: ['Home'],
      favorite: true,
      notes: 'closet',
      fields: [{ label: 'PIN', value: 'S3NT1NEL-pin', concealed: true }],
    });
    const out = join(dir, 'vault-export.csv');

    expect(await service.exportCsv('not the password', 'runova', out)).toBe(false);
    await expect(stat(out)).rejects.toThrow();

    expect(await service.exportCsv(PASSWORD, 'runova', out)).toBe(true);
    expect(await readFile(out, 'utf-8')).toContain('S3NT1NEL-pin');

    const other = await unlockedService();
    const { token } = await other.importOpen(out);
    await other.importCommit(token, null, 'skip');
    const [summary] = other.list();
    expect(summary).toMatchObject({ title: 'Router', tags: ['Home'], favorite: true });
    expect(other.reveal(summary.id, { customFieldId: summary.fields[0].id })).toBe('S3NT1NEL-pin');
  });
});
