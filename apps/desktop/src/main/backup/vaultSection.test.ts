import { describe, expect, it, vi } from 'vitest';
import { createVaultFile, openVaultFile, type VaultFileV1 } from '../vault/format';
import { MemoryVaultFiles } from '../vault/testing/memoryVaultFiles';
import { currentVaultSection, readVaultSection, restoreVaultSection } from './vaultSection';

const FAST = { N: 1024, r: 8, p: 1 };
const payload = (title: string) => ({
  schemaVersion: 1 as const,
  createdAt: 1,
  entries: [
    {
      id: 'e1',
      type: 'note' as const,
      title,
      tags: [],
      favorite: false,
      notes: 'S3NT1NEL',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
    },
  ],
});

describe('vault backup section', () => {
  it('exports the encrypted file exactly as stored, and nothing when there is no vault', async () => {
    const files = new MemoryVaultFiles();
    expect(await currentVaultSection(files)).toBeNull();
    const { file } = await createVaultFile('home vault password', payload('Home'), FAST);
    await files.write(file);
    expect(await currentVaultSection(files)).toEqual(file);
    expect(JSON.stringify(await currentVaultSection(files))).not.toContain('S3NT1NEL');
  });

  it('skips a damaged vault file instead of exporting it', async () => {
    const files = new MemoryVaultFiles();
    files.current = {
      format: 'agentmate-vault' as const /* legacy-name */,
      version: 1,
      kdf: { N: 2 ** 30 },
    };
    expect(await currentVaultSection(files)).toBeNull();
  });

  it('reads only well-formed sections from a backup', async () => {
    const { file } = await createVaultFile('home vault password', payload('Home'), FAST);
    expect(readVaultSection(file)).toEqual(file);
    expect(readVaultSection(undefined)).toBeNull();
    expect(readVaultSection({ ...file, kdf: { ...file.kdf, N: 2 ** 24 } })).toBeNull();
  });

  it('locks, keeps the old file aside, and writes the backup vault, which opens with its own password', async () => {
    const files = new MemoryVaultFiles();
    const current = await createVaultFile('this computer password', payload('Current'), FAST);
    await files.write(current.file);
    const backup = await createVaultFile('backup vault password', payload('From backup'), FAST);
    const lock = vi.fn(async () => undefined);

    await restoreVaultSection(backup.file, files, lock, new Date('2026-09-17T10:00:00Z'));

    expect(lock).toHaveBeenCalledOnce();
    expect(files.aside).toEqual({
      'vault.json.pre-restore-2026-09-17T10-00-00-000Z': current.file,
    });
    const opened = await openVaultFile(files.current as VaultFileV1, 'backup vault password');
    if (typeof opened === 'string') throw new Error(opened);
    expect(opened.payload.entries[0].title).toBe('From backup');
  });

  it('puts the old vault back if writing the restored one fails', async () => {
    const files = new MemoryVaultFiles();
    const current = await createVaultFile('this computer password', payload('Current'), FAST);
    await files.write(current.file);
    const backup = await createVaultFile('backup vault password', payload('From backup'), FAST);

    const write = files.write.bind(files);
    let calls = 0;
    files.write = async (file) => {
      calls++;
      if (calls === 1) throw new Error('disk full');
      return write(file);
    };
    await expect(
      restoreVaultSection(backup.file, files, async () => undefined, new Date()),
    ).rejects.toThrow('disk full');
    expect(files.current).toEqual(current.file);
  });
});
