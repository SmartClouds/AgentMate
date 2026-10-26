import { createHash } from 'node:crypto';
import { WP_BATCH_MAX_BYTES, WP_BATCH_MIN_BYTES, type WpItemRef } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import { type WpClient, WpRemoteError } from './client';
import { readRemoteFiles, readRemoteManifest, wpReadCap } from './remote';

/**
 * Reading an item off the site with a scripted site: everything it says about paths, hashes and
 * sizes is checked, pages end, batches shrink when the site says they are too large, and a file
 * that changes while it is read in pieces is read again or refused.
 */

const THEME: WpItemRef = { kind: 'theme', slug: 'shop' };
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const LIMITS = { maxResponseBytes: 100 * 1024, maxPathsPerRead: 3 };

type Handler = (body: Record<string, unknown>) => { data: unknown; blobs?: Uint8Array[] };

function stub(handler: Handler): { client: WpClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const client = {
    call: async (_route: string, body: Record<string, unknown>) => {
      calls.push(body);
      const reply = handler(body);
      return { data: reply.data, blobs: reply.blobs ?? [], durationMs: 1 };
    },
  } as unknown as WpClient;
  return { client, calls };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to fail.');
}

describe('readRemoteManifest', () => {
  it('reads every page and keeps only entries it can trust', async () => {
    const pages: Record<string, unknown>[] = [
      {
        isFile: false,
        entries: [
          { path: 'style.css', size: 3, sha256: 'a'.repeat(64) },
          { path: '../wp-config.php', size: 3, sha256: 'a'.repeat(64) },
          { path: 'x.css', size: -1, sha256: 'a'.repeat(64) },
          { path: 'y.css', size: 1, sha256: 'A'.repeat(64) },
          { path: 'big.bin', size: 65 * 1024 * 1024, sha256: 'b'.repeat(64) },
          null,
        ],
        skipped: [{ path: 'link', reason: 'symlink' }, { path: 5 }],
        cursor: 'page2',
      },
      { isFile: false, entries: 'oops', skipped: 'none', cursor: null },
    ];
    const { client, calls } = stub(() => ({ data: pages.shift() }));
    const item = await readRemoteManifest(client, THEME);
    expect(item.exists).toBe(true);
    expect(item.files).toEqual({ 'style.css': { size: 3, sha256: 'a'.repeat(64) } });
    expect(item.skipped).toEqual([
      { path: '../wp-config.php', reason: 'hardDenied' },
      { path: 'x.css', reason: 'hardDenied' },
      { path: 'y.css', reason: 'hardDenied' },
      { path: 'big.bin', reason: 'tooLarge' },
      { path: '', reason: 'hardDenied' },
      { path: 'link', reason: 'symlink' },
    ]);
    expect(calls[1]).toEqual({ item: THEME, cursor: 'page2' });
  });

  it('keeps at most 1000 of the paths the site says it left out', async () => {
    const skipped = Array.from({ length: 1500 }, (_, index) => ({
      path: `x${index}`,
      reason: 'symlink',
    }));
    const { client } = stub(() => ({
      data: { isFile: false, entries: [], skipped, cursor: null },
    }));
    expect((await readRemoteManifest(client, THEME)).skipped).toHaveLength(1000);
  });

  it('holds a single-file item to its own name', async () => {
    const { client } = stub(() => ({
      data: {
        isFile: true,
        entries: [
          { path: 'hello.php', size: 1, sha256: 'a'.repeat(64) },
          { path: 'other.php', size: 1, sha256: 'a'.repeat(64) },
        ],
        skipped: [],
        cursor: null,
      },
    }));
    const item = await readRemoteManifest(client, { kind: 'plugin', slug: 'hello.php' });
    expect(Object.keys(item.files)).toEqual(['hello.php']);
  });

  it('says when the site has no such item, and passes other errors on', async () => {
    const unknown = stub(() => {
      throw new WpRemoteError('itemUnknown', 'No item.');
    });
    expect(await readRemoteManifest(unknown.client, THEME)).toEqual({
      exists: false,
      isFile: false,
      files: {},
      skipped: [],
    });
    const broken = stub(() => {
      throw new WpRemoteError('internal', 'Broken.');
    });
    expect(wordPressErrorCode(await failure(readRemoteManifest(broken.client, THEME)))).toBe(
      'internal',
    );
  });

  it('stops a site that repeats a page or lists too many files', async () => {
    const looping = stub(() => ({ data: { entries: [], skipped: [], cursor: 'same' } }));
    const error = await failure(readRemoteManifest(looping.client, THEME));
    expect(error.message).toContain('without an end');

    const entries = Array.from({ length: 20_001 }, (_, index) => ({
      path: `f${index}.css`,
      size: 1,
      sha256: 'a'.repeat(64),
    }));
    const flood = stub(() => ({ data: { entries, skipped: [], cursor: null } }));
    expect(wordPressErrorCode(await failure(readRemoteManifest(flood.client, THEME)))).toBe(
      'tooLarge',
    );
  });
});

describe('readRemoteFiles', () => {
  const content: Record<string, Buffer> = {
    'a.css': Buffer.from('aaa'),
    'b.css': Buffer.from('bb'),
    'c.css': Buffer.from('c'),
    'd.css': Buffer.from('dddd'),
    'big.bin': Buffer.alloc(200 * 1024, 9),
  };

  /** A site that serves `content`, honouring offset and length. */
  function site(
    overrides: {
      tooLargeOver?: number;
      mutate?: (path: string, call: number) => Buffer | undefined;
    } = {},
  ) {
    let call = 0;
    return stub((body) => {
      call += 1;
      const files = body.files as { path: string; offset?: number; length?: number }[];
      const asked = files.reduce(
        (sum, file) =>
          sum + Math.min(file.length ?? Number.POSITIVE_INFINITY, content[file.path]?.length ?? 0),
        0,
      );
      if (overrides.tooLargeOver !== undefined && asked > overrides.tooLargeOver) {
        throw new WpRemoteError('tooLarge', 'Too large.');
      }
      const results = [];
      const blobs: Uint8Array[] = [];
      for (const file of files) {
        const bytes = overrides.mutate?.(file.path, call) ?? content[file.path];
        if (!bytes) {
          results.push({
            path: file.path,
            offset: 0,
            length: 0,
            size: 0,
            sha256: '',
            missing: true,
          });
          blobs.push(new Uint8Array(0));
          continue;
        }
        const offset = file.offset ?? 0;
        const slice = bytes.subarray(offset, offset + (file.length ?? bytes.length));
        results.push({
          path: file.path,
          offset,
          length: slice.length,
          size: bytes.length,
          sha256: sha(bytes),
        });
        blobs.push(slice);
      }
      return { data: { files: results }, blobs };
    });
  }

  /** What the plan saw: the manifest entries the reads must match. */
  function planned(path: string) {
    const bytes = content[path];
    return { path, size: bytes?.length ?? 1, sha256: bytes ? sha(bytes) : 'f'.repeat(64) };
  }

  async function readAll(
    client: WpClient,
    wanted: (string | { path: string; size: number; sha256: string })[],
    limits = LIMITS,
  ) {
    const got: Record<string, string> = {};
    let bytes = 0;
    const missing = await readRemoteFiles(
      client,
      THEME,
      wanted.map((entry) => (typeof entry === 'string' ? planned(entry) : entry)),
      {
        limits,
        isFile: false,
        onBytes: (count) => {
          bytes += count;
        },
        onFile: async (path, data, hash) => {
          expect(hash).toBe(sha(data));
          got[path] = sha(data);
        },
      },
    );
    return { got, missing, bytes };
  }

  it('reads small files in batches of at most maxPathsPerRead, and big ones in pieces', async () => {
    const { client, calls } = site();
    const { got, missing, bytes } = await readAll(client, [
      'a.css',
      'b.css',
      'c.css',
      'd.css',
      'big.bin',
      'gone.css',
    ]);
    expect(Object.keys(got).sort()).toEqual(['a.css', 'b.css', 'big.bin', 'c.css', 'd.css']);
    expect(got['big.bin']).toBe(sha(content['big.bin']));
    expect(missing).toEqual(['gone.css']);
    expect(bytes).toBe(3 + 2 + 1 + 4 + 200 * 1024);
    expect((calls[0].files as unknown[]).length).toBe(3);
    expect(
      calls.filter((body) => (body.files as { path: string }[])[0].path === 'big.bin').length,
    ).toBeGreaterThan(1);
  });

  it('halves batches and pieces when the site says they are too large', async () => {
    const { client, calls } = site({ tooLargeOver: 70 * 1024 });
    const { got } = await readAll(client, ['big.bin', 'a.css', 'b.css']);
    expect(got['big.bin']).toBe(sha(content['big.bin']));
    expect(calls.length).toBeGreaterThan(4);

    const batch = site({ tooLargeOver: 5 });
    const small = await readAll(batch.client, ['a.css', 'b.css', 'd.css']);
    expect(Object.keys(small.got).sort()).toEqual(['a.css', 'b.css', 'd.css']);
  });

  it('refuses a file that is not the one the review saw, whole or in pieces', async () => {
    const swapped = site({ mutate: (path) => (path === 'a.css' ? Buffer.from('zzz') : undefined) });
    const whole = await failure(readAll(swapped.client, ['a.css']));
    expect(wordPressErrorCode(whole)).toBe('conflict');
    expect(whole.message).toBe(
      [
        '[wp:conflict] 1 file changed on the site after the review.',
        'wp-content/themes/shop/a.css: changed on the site since the review',
      ].join(String.fromCharCode(10)),
    );

    // A site that streams far more than the manifest listed is stopped at the first piece.
    const grown = site({
      mutate: (path) => (path === 'a.css' ? Buffer.alloc(150 * 1024, 3) : undefined),
    });
    expect(wordPressErrorCode(await failure(readAll(grown.client, ['a.css'])))).toBe('conflict');

    let pieces = 0;
    const midway = site({
      mutate: (path) => {
        if (path !== 'big.bin') return undefined;
        pieces += 1;
        return pieces === 2 ? Buffer.alloc(200 * 1024, 1) : undefined;
      },
    });
    expect(wordPressErrorCode(await failure(readAll(midway.client, ['big.bin'])))).toBe('conflict');

    let calls = 0;
    const vanishing = stub((body) => {
      calls += 1;
      const file = (body.files as { path: string; offset?: number; length?: number }[])[0];
      if (calls > 1) {
        return {
          data: {
            files: [{ path: file.path, offset: 0, length: 0, size: 0, sha256: '', missing: true }],
          },
          blobs: [new Uint8Array(0)],
        };
      }
      const bytes = content['big.bin'];
      const slice = bytes.subarray(0, file.length);
      return {
        data: {
          files: [
            {
              path: file.path,
              offset: 0,
              length: slice.length,
              size: bytes.length,
              sha256: sha(bytes),
            },
          ],
        },
        blobs: [slice],
      };
    });
    expect(wordPressErrorCode(await failure(readAll(vanishing.client, ['big.bin'])))).toBe(
      'conflict',
    );
  });

  it('notes a file the site no longer has, and refuses one larger than Runova syncs', async () => {
    const gone = stub((body) => {
      const file = (body.files as { path: string }[])[0];
      return {
        data: {
          files: [{ path: file.path, offset: 0, length: 0, size: 0, sha256: '', missing: true }],
        },
        blobs: [new Uint8Array(0)],
      };
    });
    expect((await readAll(gone.client, ['big.bin'])).missing).toEqual(['big.bin']);

    const { client, calls } = site();
    const huge = { path: 'huge.bin', size: 65 * 1024 * 1024, sha256: 'a'.repeat(64) };
    expect((await failure(readAll(client, [huge]))).message).toContain('larger than');
    expect(calls).toEqual([]);
  });

  it('refuses answers that do not match what was asked or what arrived', async () => {
    const short = stub(() => ({ data: { files: [] }, blobs: [] }));
    expect((await failure(readAll(short.client, ['a.css']))).message).toContain('does not match');

    const other = stub(() => ({
      data: { files: [{ path: 'b.css', offset: 0, length: 3, size: 3, sha256: sha('aaa') }] },
      blobs: [Buffer.from('aaa')],
    }));
    expect((await failure(readAll(other.client, ['a.css']))).message).toContain('another file');

    const odd = stub(() => ({ data: { files: [null] }, blobs: [Buffer.from('aaa')] }));
    expect((await failure(readAll(odd.client, ['a.css']))).message).toContain('another file');

    // It claims the planned hash, but the bytes are not that file.
    const wrongBytes = stub(() => ({
      data: { files: [{ path: 'a.css', offset: 0, length: 3, size: 3, sha256: sha('aaa') }] },
      blobs: [Buffer.from('aab')],
    }));
    expect((await failure(readAll(wrongBytes.client, ['a.css']))).message).toContain('hash');

    const shortBlob = stub(() => ({
      data: { files: [{ path: 'a.css', offset: 0, length: 2, size: 3, sha256: sha('aaa') }] },
      blobs: [Buffer.from('aa')],
    }));
    expect((await failure(readAll(shortBlob.client, ['a.css']))).message).toContain('wrong size');

    const wrongPiece = stub((body) => {
      const file = (body.files as { path: string; offset?: number }[])[0];
      return {
        data: {
          files: [
            {
              path: file.path,
              offset: (file.offset ?? 0) + 1,
              length: 5,
              size: 200 * 1024,
              sha256: sha(content['big.bin']),
            },
          ],
        },
        blobs: [Buffer.alloc(5)],
      };
    });
    expect((await failure(readAll(wrongPiece.client, ['big.bin']))).message).toContain(
      'wrong size',
    );

    const lying = stub((body) => {
      const file = (body.files as { path: string; offset?: number; length?: number }[])[0];
      const bytes = Buffer.alloc(200 * 1024, 4);
      const offset = file.offset ?? 0;
      const slice = bytes.subarray(offset, offset + (file.length ?? bytes.length));
      return {
        data: {
          files: [
            {
              path: file.path,
              offset,
              length: slice.length,
              size: bytes.length,
              sha256: sha(content['big.bin']),
            },
          ],
        },
        blobs: [slice],
      };
    });
    expect((await failure(readAll(lying.client, ['big.bin']))).message).toContain('hash');
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new WpRemoteError('cancelled', 'Stopped.'));
    const { client } = site();
    const error = await failure(
      readRemoteFiles(client, THEME, [planned('a.css')], {
        limits: LIMITS,
        isFile: false,
        signal: controller.signal,
        onFile: async () => undefined,
      }),
    );
    expect(wordPressErrorCode(error)).toBe('cancelled');
  });

  it('sizes reads from what the site may answer', () => {
    expect(wpReadCap({ maxResponseBytes: 1000 })).toBe(WP_BATCH_MIN_BYTES);
    expect(wpReadCap({ maxResponseBytes: 1024 ** 3 })).toBe(WP_BATCH_MAX_BYTES);
    expect(wpReadCap({ maxResponseBytes: 1024 * 1024 })).toBe(Math.floor(1024 * 1024 * 0.8));
  });
});
