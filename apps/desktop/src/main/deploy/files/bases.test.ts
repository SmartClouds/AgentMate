import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BaseEntry } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { BaseTarget } from './bases';

/**
 * What the last deploy of each site left on the server: one base file per site, and beside it an
 * append-only journal a run writes to file by file, so a run that stops keeps what it finished.
 * The journal is folded into the base at the end of a run and at startup.
 */

const userData = useTempUserData();
let bases: typeof import('./bases');

const TARGET: BaseTarget = {
  protocol: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'me',
  remoteRoot: '/var/www/site',
  localFolder: '/home/me/site',
};

function entry(sha: string, size = 3): BaseEntry {
  return {
    sha256: sha.repeat(64).slice(0, 64),
    size,
    localMtimeMs: 1000,
    remote: { size, mtimeMs: 2000, via: 'sftp' },
  };
}

function basesDir(): string {
  return join(userData.dir, 'data', 'deploy-files', 'bases');
}

function baseFile(siteId: string): string {
  return join(basesDir(), `${siteId}.json`);
}

function journalFile(siteId: string): string {
  return join(basesDir(), `${siteId}.journal.jsonl`);
}

beforeEach(async () => {
  bases = await import('./bases');
});

describe('readBase', () => {
  it('starts empty for a site that was never deployed', async () => {
    const base = await bases.readBase('s1', TARGET);
    expect(base).toEqual({ version: 1, target: TARGET, files: {}, createdDirs: [] });
  });

  it('reads back what a run journaled, after folding it', async () => {
    await bases.readBase('s1', TARGET);
    const journal = await bases.openJournal('s1');
    await journal.append({ t: 'dir', path: 'css' });
    await journal.append({ t: 'put', path: 'css/site.css', entry: entry('a') });
    await journal.append({ t: 'put', path: 'index.html', entry: entry('b') });
    await journal.close();
    await bases.foldJournal('s1');
    expect(existsSync(journalFile('s1'))).toBe(false);
    const base = await bases.readBase('s1', TARGET);
    expect(Object.keys(base.files).sort()).toEqual(['css/site.css', 'index.html']);
    expect(base.createdDirs).toEqual(['css']);
  });

  it('folds a journal left behind by a run that stopped', async () => {
    await bases.readBase('s1', TARGET);
    const journal = await bases.openJournal('s1');
    await journal.append({ t: 'put', path: 'a.txt', entry: entry('a') });
    await journal.close();
    const base = await bases.readBase('s1', TARGET);
    expect(base.files['a.txt']).toEqual(entry('a'));
    expect(existsSync(journalFile('s1'))).toBe(false);
  });

  it('reads as empty when the site now points somewhere else, and forgets the old base', async () => {
    await bases.readBase('s1', TARGET);
    const journal = await bases.openJournal('s1');
    await journal.append({ t: 'put', path: 'a.txt', entry: entry('a') });
    await journal.close();
    await bases.foldJournal('s1');

    const moved = { ...TARGET, remoteRoot: '/var/www/other' };
    expect((await bases.readBase('s1', moved)).files).toEqual({});
    // A run against the new folder must not land in the old folder's base.
    const back = await bases.readBase('s1', TARGET);
    expect(back.files).toEqual({});
  });

  it.each([
    ['protocol', { protocol: 'ftps' as const }],
    ['host', { host: 'other.example.com' }],
    ['port', { port: 2222 }],
    ['username', { username: 'someone-else' }],
    ['local folder', { localFolder: '/home/me/other' }],
  ])('treats a different %s as a different target', async (_label, change) => {
    await bases.readBase('s1', TARGET);
    const journal = await bases.openJournal('s1');
    await journal.append({ t: 'put', path: 'a.txt', entry: entry('a') });
    await journal.close();
    expect((await bases.readBase('s1', { ...TARGET, ...change })).files).toEqual({});
  });

  it('reads a base recorded before the username was kept as another target for a login', async () => {
    const { username: _username, ...old } = TARGET;
    mkdirSync(basesDir(), { recursive: true });
    writeFileSync(
      baseFile('s1'),
      JSON.stringify({ version: 1, target: old, files: { 'a.txt': entry('a') }, createdDirs: [] }),
      'utf-8',
    );
    expect((await bases.peekBase('s1', TARGET)).files).toEqual({});
    const saved = { ...TARGET, host: 'saved:srv-1', port: null, username: null };
    const { username: _none, ...oldSaved } = saved;
    writeFileSync(
      baseFile('s1'),
      JSON.stringify({
        version: 1,
        target: oldSaved,
        files: { 'a.txt': entry('a') },
        createdDirs: [],
      }),
      'utf-8',
    );
    expect(Object.keys((await bases.peekBase('s1', saved)).files)).toEqual(['a.txt']);
  });

  it('reads a base file that is not JSON as empty', async () => {
    mkdirSync(basesDir(), { recursive: true });
    writeFileSync(baseFile('s1'), '{ nope', 'utf-8');
    expect((await bases.readBase('s1', TARGET)).files).toEqual({});
  });

  it('drops entries that are not shaped like a base entry', async () => {
    mkdirSync(basesDir(), { recursive: true });
    writeFileSync(
      baseFile('s1'),
      JSON.stringify({
        version: 1,
        target: TARGET,
        files: { 'good.txt': entry('a'), 'bad.txt': { sha256: 5 } },
        createdDirs: ['css', 7],
      }),
      'utf-8',
    );
    const base = await bases.readBase('s1', TARGET);
    expect(Object.keys(base.files)).toEqual(['good.txt']);
    expect(base.createdDirs).toEqual(['css']);
  });

  it('refuses a site id that could leave the bases folder', async () => {
    await expect(bases.readBase('../escape', TARGET)).rejects.toThrow(/\[files:invalidInput\]/);
  });
});

describe('foldJournal', () => {
  it('applies every kind of event in order', async () => {
    await bases.readBase('s1', TARGET);
    const journal = await bases.openJournal('s1');
    await journal.append({ t: 'dir', path: 'img' });
    await journal.append({ t: 'dir', path: 'old' });
    await journal.append({ t: 'put', path: 'img/a.png', entry: entry('a') });
    await journal.append({ t: 'put', path: 'gone.txt', entry: entry('b') });
    await journal.append({ t: 'put', path: 'dropped.txt', entry: entry('c') });
    await journal.append({ t: 'del', path: 'gone.txt' });
    await journal.append({ t: 'drop', path: 'dropped.txt' });
    await journal.append({ t: 'rmdir', path: 'old' });
    await journal.close();
    const base = await bases.foldJournal('s1');
    expect(base?.files).toEqual({ 'img/a.png': entry('a') });
    expect(base?.createdDirs).toEqual(['img']);
  });

  it('gives the same base when a journal is replayed twice', async () => {
    await bases.readBase('s1', TARGET);
    const journal = await bases.openJournal('s1');
    await journal.append({ t: 'dir', path: 'css' });
    await journal.append({ t: 'put', path: 'a.txt', entry: entry('a') });
    await journal.append({ t: 'dir', path: 'css' });
    await journal.append({ t: 'put', path: 'a.txt', entry: entry('a') });
    await journal.close();
    const base = await bases.foldJournal('s1');
    expect(base?.files).toEqual({ 'a.txt': entry('a') });
    expect(base?.createdDirs).toEqual(['css']);
  });

  it('skips a broken last line, the one a crash cut short', async () => {
    await bases.readBase('s1', TARGET);
    const journal = await bases.openJournal('s1');
    await journal.append({ t: 'put', path: 'a.txt', entry: entry('a') });
    await journal.close();
    const { appendFileSync } = await import('node:fs');
    appendFileSync(journalFile('s1'), '{"t":"put","path":"b.txt","ent', 'utf-8');
    const base = await bases.foldJournal('s1');
    expect(Object.keys(base?.files ?? {})).toEqual(['a.txt']);
  });

  it('skips lines that parse but are not events', async () => {
    await bases.readBase('s1', TARGET);
    mkdirSync(basesDir(), { recursive: true });
    writeFileSync(
      journalFile('s1'),
      [
        JSON.stringify({ t: 'put', path: 'a.txt', entry: entry('a') }),
        JSON.stringify({ t: 'explode', path: 'x' }),
        JSON.stringify({ t: 'put', path: 'b.txt', entry: { size: 'big' } }),
        '',
      ].join('\n'),
      'utf-8',
    );
    const base = await bases.foldJournal('s1');
    expect(Object.keys(base?.files ?? {})).toEqual(['a.txt']);
  });

  it('does nothing when there is no journal', async () => {
    await bases.readBase('s1', TARGET);
    expect((await bases.foldJournal('s1'))?.files).toEqual({});
  });

  it('keeps appends in order when they are not awaited one by one', async () => {
    await bases.readBase('s1', TARGET);
    const journal = await bases.openJournal('s1');
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        journal.append({ t: 'put', path: `f${index}.txt`, entry: entry('a') }),
      ),
    );
    await journal.append({ t: 'del', path: 'f3.txt' });
    await journal.close();
    const lines = readFileSync(journalFile('s1'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(21);
    const base = await bases.foldJournal('s1');
    expect(Object.keys(base?.files ?? {})).toHaveLength(19);
    expect(base?.files['f3.txt']).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'writes the base and the journal readable only by the user',
    async () => {
      await bases.readBase('s1', TARGET);
      const journal = await bases.openJournal('s1');
      await journal.append({ t: 'put', path: 'a.txt', entry: entry('a') });
      expect(statSync(journalFile('s1')).mode & 0o777).toBe(0o600);
      await journal.close();
      await bases.foldJournal('s1');
      expect(statSync(baseFile('s1')).mode & 0o777).toBe(0o600);
    },
  );
});

describe('foldAllJournals', () => {
  it('returns quietly when no site was ever deployed', async () => {
    await expect(bases.foldAllJournals()).resolves.toBe(0);
  });

  it('folds every journal it finds, a broken one included', async () => {
    await bases.readBase('s1', TARGET);
    await bases.readBase('s2', { ...TARGET, host: 'two.example.com' });
    const one = await bases.openJournal('s1');
    await one.append({ t: 'put', path: 'a.txt', entry: entry('a') });
    await one.close();
    const two = await bases.openJournal('s2');
    await two.append({ t: 'put', path: 'b.txt', entry: entry('b') });
    await two.close();
    const { appendFileSync } = await import('node:fs');
    appendFileSync(journalFile('s2'), 'garbage', 'utf-8');

    expect(await bases.foldAllJournals()).toBe(2);
    expect(existsSync(journalFile('s1'))).toBe(false);
    expect(existsSync(journalFile('s2'))).toBe(false);
    const stored = JSON.parse(readFileSync(baseFile('s2'), 'utf-8'));
    expect(Object.keys(stored.files)).toEqual(['b.txt']);
  });

  it('drops a journal that has no base to fold into', async () => {
    mkdirSync(basesDir(), { recursive: true });
    writeFileSync(
      journalFile('orphan'),
      `${JSON.stringify({ t: 'put', path: 'a', entry: entry('a') })}\n`,
    );
    await bases.foldAllJournals();
    expect(existsSync(journalFile('orphan'))).toBe(false);
  });
});

describe('peekBase', () => {
  it('applies a running journal without folding it, so the run keeps its progress', async () => {
    await bases.readBase('s1', TARGET);
    const journal = await bases.openJournal('s1');
    await journal.append({ t: 'dir', path: 'css' });
    await journal.append({ t: 'put', path: 'css/site.css', entry: entry('a') });
    const baseBefore = readFileSync(baseFile('s1'), 'utf-8');

    const peeked = await bases.peekBase('s1', TARGET);
    expect(peeked.files['css/site.css']).toEqual(entry('a'));
    expect(peeked.createdDirs).toEqual(['css']);
    expect(existsSync(journalFile('s1'))).toBe(true);
    expect(readFileSync(baseFile('s1'), 'utf-8')).toBe(baseBefore);

    // The run goes on appending, and its fold still sees every line.
    await journal.append({ t: 'put', path: 'index.html', entry: entry('b') });
    await journal.close();
    await bases.foldJournal('s1');
    const base = await bases.readBase('s1', TARGET);
    expect(Object.keys(base.files).sort()).toEqual(['css/site.css', 'index.html']);
  });

  it('reads as empty for another target and writes nothing', async () => {
    await bases.readBase('s1', TARGET);
    const journal = await bases.openJournal('s1');
    await journal.append({ t: 'put', path: 'a.txt', entry: entry('a') });
    await journal.close();
    const baseBefore = readFileSync(baseFile('s1'), 'utf-8');

    const other = { ...TARGET, remoteRoot: '/var/www/other' };
    expect(await bases.peekBase('s1', other)).toEqual({
      version: 1,
      target: other,
      files: {},
      createdDirs: [],
    });
    expect(readFileSync(baseFile('s1'), 'utf-8')).toBe(baseBefore);
    expect(existsSync(journalFile('s1'))).toBe(true);
  });

  it('reads as empty for a site that was never deployed, without making a base', async () => {
    expect(await bases.peekBase('fresh', TARGET)).toEqual({
      version: 1,
      target: TARGET,
      files: {},
      createdDirs: [],
    });
    expect(existsSync(baseFile('fresh'))).toBe(false);
  });

  it('refuses a site id that could leave the bases folder', async () => {
    await expect(bases.peekBase('../x', TARGET)).rejects.toThrow('[files:invalidInput]');
  });
});

describe('resetBase and removeBaseFiles', () => {
  async function deployOne(): Promise<void> {
    await bases.readBase('s1', TARGET);
    const journal = await bases.openJournal('s1');
    await journal.append({ t: 'dir', path: 'css' });
    await journal.append({ t: 'put', path: 'a.txt', entry: entry('a') });
    await journal.close();
  }

  it('forgets what was deployed, and the next read is a first deploy', async () => {
    await deployOne();
    await bases.resetBase('s1');
    expect(existsSync(journalFile('s1'))).toBe(false);
    expect(await bases.readBase('s1', TARGET)).toEqual({
      version: 1,
      target: TARGET,
      files: {},
      createdDirs: [],
    });
  });

  it('removes the base and the journal of a removed site', async () => {
    await deployOne();
    await bases.removeBaseFiles('s1');
    expect(existsSync(baseFile('s1'))).toBe(false);
    expect(existsSync(journalFile('s1'))).toBe(false);
  });
});

describe('baseTargetOf', () => {
  it('uses the login of a site of its own', () => {
    expect(
      bases.baseTargetOf({
        protocol: 'ftps',
        connection: {
          kind: 'custom',
          host: 'ftp.example.com',
          port: 21,
          username: 'me',
          authMethod: 'password',
          privateKeyPath: null,
          hostKeyFingerprint: null,
          tlsPin: null,
          tlsServername: null,
          secretEnvelope: null,
        },
        remoteRoot: '/public_html',
        localFolder: '/home/me/site',
      }),
    ).toEqual({
      protocol: 'ftps',
      host: 'ftp.example.com',
      port: 21,
      username: 'me',
      remoteRoot: '/public_html',
      localFolder: '/home/me/site',
    });
  });

  it('uses the saved server id for a server saved in Remote', () => {
    expect(
      bases.baseTargetOf({
        protocol: 'sftp',
        connection: { kind: 'saved', sshServerId: 'srv-1' },
        remoteRoot: '/srv',
        localFolder: '/home/me/site',
      }),
    ).toEqual({
      protocol: 'sftp',
      host: 'saved:srv-1',
      port: null,
      username: null,
      remoteRoot: '/srv',
      localFolder: '/home/me/site',
    });
  });
});
