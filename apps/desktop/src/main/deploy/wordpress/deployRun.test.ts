import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WpDeployState, WpItemRef, WpLimits, WpPlannedChange } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import { type WpClient, WpRemoteError } from './client';
import {
  conflictsMessage,
  readPlannedFile,
  refusalsMessage,
  runDeploy,
  syntaxErrorMessage,
  type WpDeployRunInput,
} from './deployRun';

/**
 * The deploy run against a scripted site, for the turns the fake connector does not take: the
 * site refusing things at begin, ending a deploy on its own, losing upload bytes, failing its own
 * health check, and a clean-up that cannot reach it.
 */

const THEME: WpItemRef = { kind: 'theme', slug: 'shop' };
const HELLO: WpItemRef = { kind: 'plugin', slug: 'hello.php' };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const LIMITS: WpLimits = {
  maxRequestBytes: 8 * 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  timeBudgetSeconds: 10,
  maxPathsPerRead: 100,
  manifestPageSize: 500,
  maxFilesPerItem: 20_000,
};
const isFiles = new Map([
  ['theme:shop', false],
  ['plugin:hello.php', true],
]);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runova-wp-deployrun-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Routes = Partial<Record<string, (body: Record<string, unknown>) => unknown>>;

function scripted(routes: Routes): { client: WpClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    call: async (route: string, body: Record<string, unknown>) => {
      calls.push(route);
      const handler = routes[route];
      if (!handler) throw new Error(`Unexpected ${route}`);
      return { data: handler(body), blobs: [], durationMs: 1 };
    },
  } as unknown as WpClient;
  return { client, calls };
}

function put(path: string, content: string): { sha256: string; size: number } {
  const full = join(root, ...path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return { sha256: sha(content), size: Buffer.byteLength(content) };
}

function upload(path: string, expectedRemote: string | null = null): WpPlannedChange {
  return {
    item: THEME,
    path,
    local: 'modified',
    remote: null,
    action: 'upload',
    expectedRemote,
    size: 1,
  };
}

function input(overrides: Partial<WpDeployRunInput> & Pick<WpDeployRunInput, 'client'>) {
  const ended: WpDeployState[] = [];
  const base: WpDeployRunInput = {
    projectRoot: root,
    label: 'Test',
    changes: [upload('style.css')],
    items: [{ item: THEME, isFile: false, create: false }],
    local: new Map([
      ['theme:shop', { 'style.css': put('wp-content/themes/shop/style.css', 'css') }],
    ]),
    limits: LIMITS,
    force: false,
    report: () => undefined,
    now: Date.now,
    external: async () => ({ name: 'external', status: 200, ok: true, detail: '' }),
    started: async () => undefined,
    ended: async (_id, state) => {
      ended.push(state);
    },
    ...overrides,
  };
  return { run: base, ended };
}

const okUpload = (body: Record<string, unknown>) => ({
  received: (body.chunks as { op: number; offset: number }[]).map((chunk) => ({
    op: chunk.op,
    nextOffset: 3,
  })),
});

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to fail.');
}

describe('messages', () => {
  it('lists syntax errors by project path and line', () => {
    const error = syntaxErrorMessage(
      [
        { item: THEME, path: 'a.php', line: 3, message: 'unexpected }' },
        { item: THEME, path: 'a.php', line: 9, message: 'x\nnext' },
        { item: HELLO, path: 'hello.php', line: 1.5, message: 'bad' },
        { item: null as unknown as WpItemRef, path: 'odd.php', line: 1, message: 'm' },
      ],
      isFiles,
    );
    expect(error.message).toBe(
      [
        '[wp:syntaxError] 3 PHP files have syntax errors.',
        'wp-content/themes/shop/a.php:3: unexpected }',
        'wp-content/themes/shop/a.php:9: x next',
        'wp-content/plugins/hello.php:0: bad',
        'odd.php:1: m',
      ].join('\n'),
    );
  });

  it('says what each conflict is', () => {
    expect(
      conflictsMessage(
        [
          { item: THEME, path: 'a.css', expected: 'x', actual: null },
          { item: THEME, path: 'b.css', expected: null, actual: 'y' },
          { item: THEME, path: 'c.css', expected: 'x', actual: 'y' },
        ],
        isFiles,
      ).message,
    ).toBe(
      [
        '[wp:conflict] 3 files changed on the site.',
        'wp-content/themes/shop/a.css: deleted on the site since the plan',
        'wp-content/themes/shop/b.css: already on the site',
        'wp-content/themes/shop/c.css: changed on the site since the plan',
      ].join('\n'),
    );
  });

  it('picks the code of the first refusal that cannot be forced', () => {
    const cases: [WpPlannedChange['item'], string, boolean, string][] = [
      [THEME, 'traversal', false, 'pathRejected'],
      [THEME, 'itemUnknown', false, 'itemUnknown'],
      [THEME, 'itemProtected', false, 'itemProtected'],
      [THEME, 'tooLarge', false, 'tooLarge'],
      [THEME, 'notWritable', false, 'notDirect'],
      [THEME, 'touchesActiveThemeCore', true, 'conflict'],
    ];
    for (const [item, reason, forceable, code] of cases) {
      const error = refusalsMessage(
        [{ item, path: 'x.php', reason: reason as never, forceable }],
        isFiles,
      );
      expect(wordPressErrorCode(error), reason).toBe(code);
      expect(error.message).toContain('The site refused 1 change.');
    }
    const item = refusalsMessage(
      [{ item: THEME, path: '', reason: 'odd\nreason' as never, forceable: false }],
      isFiles,
    );
    expect(item.message).toContain('wp-content/themes/shop: odd reason');
  });
});

describe('runDeploy', () => {
  it('refuses an empty deploy, and files that changed or came back since the plan', async () => {
    const { client } = scripted({});
    const empty = input({ client, changes: [] });
    expect(wordPressErrorCode(await failure(runDeploy(empty.run)))).toBe('badRequest');

    const changed = input({ client });
    put('wp-content/themes/shop/style.css', 'other');
    expect(wordPressErrorCode(await failure(runDeploy(changed.run)))).toBe('localChanged');

    const back = input({
      client,
      changes: [
        {
          item: THEME,
          path: 'gone.css',
          local: 'deleted',
          remote: null,
          action: 'deleteRemote',
          expectedRemote: 'x',
          size: 0,
        },
      ],
      local: new Map([['theme:shop', {}]]),
    });
    put('wp-content/themes/shop/gone.css', 'returned');
    expect(wordPressErrorCode(await failure(runDeploy(back.run)))).toBe('localChanged');
    const same = input({ client });
    const samePlan = {
      ...same.run,
      local: new Map([['theme:shop', { 'style.css': { sha256: sha('cs!'), size: 3 } }]]),
    };
    expect(wordPressErrorCode(await failure(runDeploy(samePlan)))).toBe('localChanged');
  });

  it('skips conflicts unless forced, and sends forced deletes', async () => {
    const conflict: WpPlannedChange = {
      item: THEME,
      path: 'gone.css',
      local: 'deleted',
      remote: 'modified',
      action: 'conflict',
      expectedRemote: 'y'.repeat(64),
      size: 0,
    };
    const { client } = scripted({});
    const skipped = input({ client, changes: [conflict] });
    expect(wordPressErrorCode(await failure(runDeploy(skipped.run)))).toBe('badRequest');

    let ops: unknown[] = [];
    const forced = scripted({
      '/deploy/begin': (body) => {
        ops = body.ops as unknown[];
        expect(body.force).toBe(true);
        return { deployId: null, limits: LIMITS, baseline: [], conflicts: [], refusals: [] };
      },
    });
    const run = input({
      client: forced.client,
      changes: [conflict],
      force: true,
      local: new Map([['theme:shop', {}]]),
    });
    await failure(runDeploy(run.run));
    expect(ops).toEqual([
      { op: 'delete', item: THEME, path: 'gone.css', expected: 'y'.repeat(64) },
    ]);
  });

  it('reports begin refusals and conflicts without opening anything', async () => {
    const { client } = scripted({
      '/deploy/begin': () => ({
        deployId: null,
        limits: LIMITS,
        baseline: [],
        conflicts: [{ item: THEME, path: 'style.css', expected: 'a', actual: 'b' }],
        refusals: [],
      }),
    });
    const { run, ended } = input({ client });
    expect(wordPressErrorCode(await failure(runDeploy(run)))).toBe('conflict');
    expect(ended).toEqual([]);
  });

  it('returns the state the site ended a deploy in, and refuses one it expired', async () => {
    const rolled = scripted({
      '/deploy/begin': () => ({
        deployId: 'd1',
        limits: LIMITS,
        baseline: [],
        conflicts: [],
        refusals: [],
      }),
      '/deploy/upload': okUpload,
      '/deploy/commit': () => ({
        state: 'rolledBack',
        reason: 'interrupted',
        progress: { done: 0, total: 1 },
      }),
    });
    const first = input({ client: rolled.client });
    expect(await runDeploy(first.run)).toMatchObject({
      state: 'rolledBack',
      reason: 'interrupted',
    });
    expect(first.ended).toEqual(['rolledBack']);

    const expired = scripted({
      '/deploy/begin': () => ({
        deployId: 'd2',
        limits: LIMITS,
        baseline: [],
        conflicts: [],
        refusals: [],
      }),
      '/deploy/upload': okUpload,
      '/deploy/commit': () => ({ state: 'expired', progress: { done: 0, total: 1 } }),
      '/deploy/history': () => ({ deploys: [null, { deployId: 'd2', state: 'expired' }] }),
      '/deploy/rollback': () => ({ state: 'expired', restored: 0, removed: 0 }),
    });
    const second = input({ client: expired.client });
    expect(wordPressErrorCode(await failure(runDeploy(second.run)))).toBe('invalidState');
    expect(expired.calls.at(-1)).toBe('/deploy/rollback');
    expect(second.ended).toEqual(['expired']);
  });

  it('aborts on commit conflicts and refusals, and keeps going while the site applies', async () => {
    for (const reply of [
      {
        state: 'open',
        progress: { done: 0, total: 1 },
        conflicts: [{ item: THEME, path: 'a', expected: 'x', actual: 'y' }],
      },
      {
        state: 'open',
        progress: { done: 0, total: 1 },
        refusals: [{ item: THEME, path: 'a', reason: 'symlink', forceable: false }],
      },
    ]) {
      const site = scripted({
        '/deploy/begin': () => ({
          deployId: 'd1',
          limits: LIMITS,
          baseline: [],
          conflicts: [],
          refusals: [],
        }),
        '/deploy/upload': okUpload,
        '/deploy/commit': () => reply,
        '/deploy/abort': () => ({ state: 'aborted' }),
      });
      const { run, ended } = input({ client: site.client });
      await failure(runDeploy(run));
      expect(site.calls.at(-1)).toBe('/deploy/abort');
      expect(ended).toEqual(['aborted']);
    }

    let commits = 0;
    const slow = scripted({
      '/deploy/begin': () => ({
        deployId: 'd1',
        limits: LIMITS,
        baseline: [],
        conflicts: [],
        refusals: [],
      }),
      '/deploy/upload': okUpload,
      '/deploy/commit': () => {
        commits += 1;
        return commits < 3
          ? { state: 'applying' }
          : { state: 'applied', progress: { done: 1, total: 1 } };
      },
      '/deploy/verify': () => ({ state: 'applied', healthy: false, checks: 'none' }),
      '/deploy/history': () => ({ deploys: 'none' }),
      '/deploy/rollback': () => ({ state: 'rolledBack', restored: 1, removed: 0 }),
    });
    const healthy = input({ client: slow.client });
    expect(await runDeploy(healthy.run)).toMatchObject({
      state: 'rolledBack',
      reason: 'healthCheck',
    });
    expect(commits).toBe(3);
  });

  it('ignores a home page that was already failing before the deploy', async () => {
    const site = scripted({
      '/deploy/begin': () => ({
        deployId: 'd1',
        limits: LIMITS,
        baseline: [],
        conflicts: [],
        refusals: [],
      }),
      '/deploy/upload': okUpload,
      '/deploy/commit': () => ({ state: 'applied', progress: { done: 1, total: 1 } }),
      '/deploy/verify': () => ({ state: 'applied', healthy: true, checks: [] }),
      '/deploy/finalize': () => ({ state: 'rolledBack', reason: 'notConfirmed' }),
    });
    const { run, ended } = input({
      client: site.client,
      external: async () => ({ name: 'external', status: 500, ok: false, detail: 'x' }),
    });
    expect(await runDeploy(run)).toMatchObject({ state: 'rolledBack', reason: 'notConfirmed' });
    expect(ended).toEqual(['rolledBack']);
  });

  it("reports the guard's rollback when the site refuses a finalize that came too late", async () => {
    const site = scripted({
      '/deploy/begin': () => ({
        deployId: 'd1',
        limits: LIMITS,
        baseline: [],
        conflicts: [],
        refusals: [],
      }),
      '/deploy/upload': okUpload,
      '/deploy/commit': () => ({ state: 'applied', progress: { done: 1, total: 1 } }),
      '/deploy/verify': () => ({ state: 'applied', healthy: true, checks: [] }),
      '/deploy/finalize': () => {
        throw new WpRemoteError('invalidState', 'Only an applied deploy can be finalized.');
      },
      '/deploy/history': () => ({
        deploys: [{ deployId: 'd1', state: 'rolledBack', reason: 'fatalError' }],
      }),
    });
    const { run, ended } = input({ client: site.client });
    expect(await runDeploy(run)).toMatchObject({ state: 'rolledBack', reason: 'fatalError' });
    expect(ended).toEqual(['rolledBack']);
    expect(site.calls).not.toContain('/deploy/rollback');
  });

  it('reports the rollback when the deployed code fatals every request', async () => {
    const broken = () => {
      throw new WpRemoteError('foreignResponse', 'Something else answered (HTTP 500).', {}, 500);
    };
    const site = scripted({
      '/deploy/begin': () => ({
        deployId: 'd1',
        limits: LIMITS,
        baseline: [],
        conflicts: [],
        refusals: [],
      }),
      '/deploy/upload': okUpload,
      '/deploy/commit': () => ({ state: 'applied', progress: { done: 1, total: 1 } }),
      '/deploy/verify': broken,
      '/deploy/history': broken,
      '/deploy/rollback': broken,
      '/rescue/status': () => ({
        pending: null,
        last: { deployId: 'd1', state: 'rolledBack', reason: 'fatalError' },
      }),
    });
    const { run, ended } = input({ client: site.client });
    expect(await runDeploy(run)).toMatchObject({ state: 'rolledBack', reason: 'fatalError' });
    expect(ended).toEqual(['rolledBack']);
    expect(site.calls).not.toContain('/deploy/history');
  });

  it('rolls a broken deploy back through the rescue route when the guard has not yet', async () => {
    const broken = () => {
      throw new WpRemoteError('foreignResponse', 'Something else answered (HTTP 500).', {}, 500);
    };
    const site = scripted({
      '/deploy/begin': () => ({
        deployId: 'd1',
        limits: LIMITS,
        baseline: [],
        conflicts: [],
        refusals: [],
      }),
      '/deploy/upload': okUpload,
      '/deploy/commit': () => ({ state: 'applied', progress: { done: 1, total: 1 } }),
      '/deploy/verify': broken,
      '/rescue/status': () => ({
        pending: { deployId: 'd1', state: 'applied', deadline: 99 },
        last: null,
      }),
      '/rescue/rollback': () => ({ state: 'rolledBack', reason: 'requested' }),
    });
    const { run, ended } = input({ client: site.client });
    expect(await runDeploy(run)).toMatchObject({ state: 'rolledBack', reason: 'healthCheck' });
    expect(ended).toEqual(['rolledBack']);
    expect(site.calls).toContain('/rescue/rollback');
  });

  it('still fails a refused finalize when the site did not roll it back', async () => {
    const site = scripted({
      '/deploy/begin': () => ({
        deployId: 'd1',
        limits: LIMITS,
        baseline: [],
        conflicts: [],
        refusals: [],
      }),
      '/deploy/upload': okUpload,
      '/deploy/commit': () => ({ state: 'applied', progress: { done: 1, total: 1 } }),
      '/deploy/verify': () => ({ state: 'applied', healthy: true, checks: [] }),
      '/deploy/finalize': () => {
        throw new WpRemoteError('invalidState', 'No.');
      },
      '/deploy/history': () => ({ deploys: [] }),
      '/deploy/rollback': () => ({
        state: 'rolledBack',
        reason: 'requested',
        restored: 1,
        removed: 0,
      }),
    });
    const { run } = input({ client: site.client });
    await expect(runDeploy(run)).rejects.toThrow(/invalidState/);
  });

  it('reports done when the finalize reply was lost but the site finished', async () => {
    const site = scripted({
      '/deploy/begin': () => ({
        deployId: 'd1',
        limits: LIMITS,
        baseline: [],
        conflicts: [],
        refusals: [],
      }),
      '/deploy/upload': okUpload,
      '/deploy/commit': () => ({ state: 'applied', progress: { done: 1, total: 1 } }),
      '/deploy/verify': () => ({ state: 'applied', healthy: true, checks: [] }),
      '/deploy/finalize': () => {
        throw new WpRemoteError('timeout', 'Lost.');
      },
      '/deploy/history': () => ({ deploys: [{ deployId: 'd1', state: 'done' }] }),
    });
    const { run, ended } = input({ client: site.client });
    expect(await runDeploy(run)).toMatchObject({ deployId: 'd1', state: 'done' });
    expect(ended).toEqual(['done']);
    expect(site.calls).not.toContain('/deploy/rollback');
  });

  it('stops when the site lost upload bytes, and survives a clean-up it cannot do', async () => {
    const site = scripted({
      '/deploy/begin': () => ({
        deployId: 'd1',
        limits: LIMITS,
        baseline: [],
        conflicts: [],
        refusals: [],
      }),
      '/deploy/upload': () => ({ received: [{ op: 0, nextOffset: 1 }] }),
      '/deploy/abort': () => {
        throw new WpRemoteError('unreachable', 'Gone.');
      },
    });
    const { run, ended } = input({ client: site.client });
    expect((await failure(runDeploy(run))).message).toContain('lost part of');
    expect(ended).toEqual([]);
  });

  it('halves uploads the site finds too large, down to the floor', async () => {
    const site = scripted({
      '/deploy/begin': () => ({
        deployId: 'd1',
        limits: LIMITS,
        baseline: [],
        conflicts: [],
        refusals: [],
      }),
      '/deploy/upload': () => {
        throw new WpRemoteError('tooLarge', 'Too large.');
      },
      '/deploy/abort': () => ({ state: 'aborted' }),
    });
    const { run, ended } = input({ client: site.client });
    expect(wordPressErrorCode(await failure(runDeploy(run)))).toBe('bodyTooLarge');
    // 512 KB, 256 KB, 128 KB, 64 KB, then it gives up.
    expect(site.calls.filter((route) => route === '/deploy/upload').length).toBe(4);
    expect(ended).toEqual(['aborted']);
  });

  it('stops between upload batches when cancelled', async () => {
    const controller = new AbortController();
    const site = scripted({
      '/deploy/begin': () => {
        controller.abort(new WpRemoteError('cancelled', 'Stopped.'));
        return { deployId: 'd1', limits: LIMITS, baseline: [], conflicts: [], refusals: [] };
      },
      '/deploy/abort': () => ({ state: 'aborted' }),
    });
    const { run } = input({ client: site.client, signal: controller.signal });
    expect(wordPressErrorCode(await failure(runDeploy(run)))).toBe('cancelled');
  });

  it('sends the bytes it hashed, cut from one read of each file', async () => {
    const sent: Buffer[] = [];
    const site = scripted({
      '/deploy/begin': () => ({
        deployId: 'd1',
        limits: LIMITS,
        baseline: [],
        conflicts: [],
        refusals: [],
      }),
      '/deploy/upload': okUpload,
      '/deploy/commit': () => ({ state: 'applied', progress: { done: 1, total: 1 } }),
      '/deploy/verify': () => ({ state: 'applied', healthy: true, checks: [] }),
      '/deploy/finalize': () => ({ state: 'done' }),
    });
    const client = {
      call: async (
        route: string,
        body: Record<string, unknown>,
        options?: { blobs?: Uint8Array[] },
      ) => {
        if (route === '/deploy/upload')
          sent.push(...(options?.blobs ?? []).map((blob) => Buffer.from(blob)));
        return site.client.call(route as never, body as never, options as never);
      },
    } as unknown as WpClient;
    const { run } = input({ client });
    expect((await runDeploy(run)).state).toBe('done');
    expect(Buffer.concat(sent).toString()).toBe('css');
  });
});

describe('readPlannedFile', () => {
  const path = 'wp-content/themes/shop/a.css';

  function planned(content: string, absolute = join(root, ...path.split('/'))) {
    return {
      absolute,
      mirror: path,
      op: { sha256: sha(content), size: Buffer.byteLength(content) },
    };
  }

  it('reads the planned bytes once', async () => {
    put(path, 'abc');
    expect((await readPlannedFile(planned('abc'))).toString()).toBe('abc');
  });

  it('refuses other bytes, another size, a folder, or a missing file', async () => {
    put(path, 'abc');
    expect(wordPressErrorCode(await failure(readPlannedFile(planned('abd'))))).toBe('localChanged');
    expect(wordPressErrorCode(await failure(readPlannedFile(planned('abcd'))))).toBe(
      'localChanged',
    );
    mkdirSync(join(root, 'folder.css'));
    expect(
      wordPressErrorCode(await failure(readPlannedFile(planned('abc', join(root, 'folder.css'))))),
    ).toBe('localChanged');
    expect(
      wordPressErrorCode(await failure(readPlannedFile(planned('abc', join(root, 'gone.css'))))),
    ).toBe('localChanged');
  });

  it('refuses a file that became a link, even to the same bytes', async () => {
    put('outside/secret.css', 'abc');
    mkdirSync(join(root, 'wp-content', 'themes', 'shop'), { recursive: true });
    try {
      symlinkSync(join(root, 'outside', 'secret.css'), join(root, ...path.split('/')), 'file');
    } catch {
      // Creating a file symlink needs developer mode on Windows.
      return;
    }
    expect(wordPressErrorCode(await failure(readPlannedFile(planned('abc'))))).toBe('localChanged');
  });
});
