import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { extract, list } from 'tar';
import { describe, expect, it } from 'vitest';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import {
  BuildContextError,
  buildContextTarball,
  MAX_BUILD_CONTEXT_BYTES,
  MAX_BUILD_CONTEXT_ENTRIES,
} from './buildContext';

/**
 * A stack's build context goes to the server as a .tar.gz holding what Docker would send to the
 * builder, and nothing it would leave out: what .dockerignore excludes (secrets, node_modules,
 * .git) never leaves this computer. The caps match what the server core accepts, and a context
 * that is too big is refused here, with the folders that make it big.
 */

interface Listed {
  path: string;
  type: string;
  mode: number;
}

async function listed(archive: string): Promise<Listed[]> {
  const found: Listed[] = [];
  await list({
    file: archive,
    onReadEntry: (entry) =>
      found.push({ path: entry.path, type: entry.type, mode: entry.mode ?? 0 }),
  });
  return found;
}

function project(files: Record<string, string>): { root: string; output: string } {
  const workspace = tempDir('runova-context-');
  const root = join(workspace, 'project');
  mkdirSync(root);
  writeTree(root, files);
  return { root, output: join(workspace, 'context.tar.gz') };
}

async function refusal(promise: Promise<unknown>): Promise<BuildContextError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BuildContextError);
  return error as BuildContextError;
}

/** Whether this machine lets a normal user create symbolic links (Windows needs Developer Mode). */
function canSymlink(): boolean {
  const folder = tempDir('runova-link-probe-');
  try {
    symlinkSync('target', join(folder, 'link'));
    return true;
  } catch {
    return false;
  }
}

describe('buildContextTarball', () => {
  it('packs what .dockerignore keeps, and always the Dockerfile and the ignore file', async () => {
    const { root, output } = project({
      Dockerfile: 'FROM node:22\n',
      '.dockerignore':
        '# build only what ships\nnode_modules\n*.log\n!keep.log\nsecrets/\n.env\nDockerfile\n',
      'src/app.js': 'console.log(1)\n',
      'src/util/math.js': 'export {}\n',
      'node_modules/left-pad/index.js': 'module.exports = 1\n',
      'debug.log': 'noise\n',
      'keep.log': 'kept\n',
      'secrets/key.pem': '-----BEGIN-----\n',
      '.env': 'TOKEN=1\n',
    });
    mkdirSync(join(root, 'empty'));

    const result = await buildContextTarball({ root, output });

    const paths = (await listed(output)).map((entry) => entry.path);
    expect(paths).toEqual([
      '.dockerignore',
      'Dockerfile',
      'empty/',
      'keep.log',
      'src/',
      'src/app.js',
      'src/util/',
      'src/util/math.js',
    ]);
    expect(result.entries).toBe(paths.length);
    expect(result.contentBytes).toBe(
      ['Dockerfile', '.dockerignore', 'keep.log', 'src/app.js', 'src/util/math.js']
        .map((file) => statSync(join(root, file)).size)
        .reduce((sum, size) => sum + size, 0),
    );
    expect(result.archiveBytes).toBe(statSync(output).size);
    expect(result.sha256).toBe(createHash('sha256').update(readFileSync(output)).digest('hex'));
    expect(result.skipped).toEqual([]);

    const unpacked = tempDir('runova-context-out-');
    await extract({ file: output, cwd: unpacked });
    expect(readFileSync(join(unpacked, 'src/app.js'), 'utf8')).toBe('console.log(1)\n');
  });

  it('looks inside a left-out folder when an exception puts something in it back', async () => {
    const { root, output } = project({
      Dockerfile: 'FROM scratch\n',
      '.dockerignore': 'docs\n!docs/README.md\n',
      'docs/README.md': '# read me\n',
      'docs/internal.md': 'not shipped\n',
    });

    await buildContextTarball({ root, output });

    expect((await listed(output)).map((entry) => entry.path)).toEqual([
      '.dockerignore',
      'Dockerfile',
      'docs/README.md',
    ]);
  });

  it('sends a Dockerfile named in the options even from a folder that is left out', async () => {
    const { root, output } = project({
      'docker/prod.Dockerfile': 'FROM scratch\n',
      'docker/notes.txt': 'not shipped\n',
      'app.txt': 'app\n',
      '.dockerignore': 'docker\n',
    });

    await buildContextTarball({ root, output, alwaysInclude: ['docker/prod.Dockerfile'] });

    expect((await listed(output)).map((entry) => entry.path)).toEqual([
      '.dockerignore',
      'app.txt',
      'docker/prod.Dockerfile',
    ]);
  });

  it('reads another ignore file when told to, and works without any', async () => {
    const custom = project({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'build.dockerignore': 'b.txt\n' });
    await buildContextTarball({ ...custom, ignoreFile: 'build.dockerignore' });
    expect((await listed(custom.output)).map((entry) => entry.path)).toEqual([
      'a.txt',
      'build.dockerignore',
    ]);

    const none = project({ 'a.txt': 'a\n' });
    await buildContextTarball(none);
    expect((await listed(none.output)).map((entry) => entry.path)).toEqual(['a.txt']);
  });

  it('refuses a context larger than the server takes, naming the biggest parts', async () => {
    const { root, output } = project({
      'small.txt': 'x',
      'assets/video.bin': 'v'.repeat(3000),
      'assets/poster.png': 'p'.repeat(500),
      'data/dump.sql': 'd'.repeat(1500),
    });

    const error = await refusal(buildContextTarball({ root, output, maxBytes: 4000 }));

    expect(error.code).toBe('too-large');
    expect(error.message).toMatch(/4\.9 KB, more than the 3\.9 KB/);
    expect(error.message).toMatch(/assets \(3\.4 KB\), data \(1\.5 KB\) and small\.txt/);
    expect(error.message).toMatch(/\.dockerignore/);
    expect(error.largest.map((part) => part.path)).toEqual(['assets', 'data', 'small.txt']);
    expect(existsSync(output)).toBe(false);
  });

  it('refuses a context with more entries than the server takes', async () => {
    const { root, output } = project({ 'a.txt': '', 'b.txt': '', 'c/d.txt': '' });

    const error = await refusal(buildContextTarball({ root, output, maxEntries: 3 }));

    expect(error.code).toBe('too-many-entries');
    expect(error.message).toMatch(/more than 3 files and folders/);
    expect(existsSync(output)).toBe(false);
  });

  it('defaults to the caps the server core enforces', () => {
    expect(MAX_BUILD_CONTEXT_BYTES).toBe(256 * 1024 * 1024);
    expect(MAX_BUILD_CONTEXT_ENTRIES).toBe(50_000);
  });

  it('refuses an ignore file Docker would read differently, with its line', async () => {
    const { root, output } = project({ 'a.txt': '', '.dockerignore': 'ok\n[z-a]\n' });

    const error = await refusal(buildContextTarball({ root, output }));

    expect(error.code).toBe('ignore-file');
    expect(error.message).toMatch(/\.dockerignore, line 2/);
  });

  it('refuses to write the archive inside the folder it packs, or to pack a file', async () => {
    const { root } = project({ 'a.txt': '' });
    expect(
      (await refusal(buildContextTarball({ root, output: join(root, 'out.tar.gz') }))).code,
    ).toBe('output-inside');
    const notAFolder = join(root, 'a.txt');
    expect(
      (await refusal(buildContextTarball({ root: notAFolder, output: join(root, '..', 'x.tgz') })))
        .code,
    ).toBe('not-a-folder');
  });

  it('gives every file the execute bit on Windows, as the Docker CLI does there', async () => {
    const { root, output } = project({ 'run.sh': '#!/bin/sh\n', 'lib/data.txt': 'x' });

    await buildContextTarball({ root, output, windowsModes: true });

    for (const entry of await listed(output)) expect(entry.mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps execute bits elsewhere, without write access for others',
    async () => {
      const { root, output } = project({ 'run.sh': '#!/bin/sh\n', 'data.txt': 'x' });
      chmodSync(join(root, 'run.sh'), 0o777);
      chmodSync(join(root, 'data.txt'), 0o666);

      await buildContextTarball({ root, output, windowsModes: false });

      const modes = Object.fromEntries(
        (await listed(output)).map((entry) => [entry.path, entry.mode & 0o777]),
      );
      expect(modes).toEqual({ 'data.txt': 0o644, 'run.sh': 0o755 });
    },
  );

  it.skipIf(!canSymlink())(
    'keeps links that stay inside, and refuses those that leave',
    async () => {
      const inside = project({ 'config/app.json': '{}' });
      symlinkSync('config/app.json', join(inside.root, 'current.json'));
      await buildContextTarball(inside);
      expect(await listed(inside.output)).toContainEqual(
        expect.objectContaining({ path: 'current.json', type: 'SymbolicLink' }),
      );

      const outside = project({ 'config/app.json': '{}' });
      writeFileSync(join(outside.root, '..', 'secret.txt'), 'secret');
      symlinkSync('../../secret.txt', join(outside.root, 'config', 'leak.txt'));
      const error = await refusal(buildContextTarball(outside));
      expect(error.code).toBe('link-outside');
      expect(error.message).toMatch(/config\/leak\.txt/);
      expect(existsSync(outside.output)).toBe(false);
    },
  );
});
