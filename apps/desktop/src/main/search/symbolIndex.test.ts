import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SymbolIndex, SymbolIndexPayload } from '../../shared/apiTypes';
import { SYMBOL_KINDS } from '../../shared/symbolKinds';
import { tempDir, writeTree } from '../../test/main/fixtures';
import { indexProjectFiles } from '../explorer/fileIndex';
import { ripgrepPath } from './ripgrepPath';
import { createSymbolIndexer } from './symbolIndex';

/**
 * The symbol index runs the real ripgrep over a project on disk, so these also prove each
 * language's line filter is a pattern ripgrep accepts and lets the declarations through.
 */

function full(payload: SymbolIndexPayload): SymbolIndex {
  if ('unchanged' in payload) throw new Error('expected a full index');
  return payload;
}

function described(index: SymbolIndex): string[] {
  return index.names.map((name, at) => {
    const container = index.containers[at] ? `${index.containers[at]}.` : '';
    return `${index.files[index.fileOf[at]]} ${SYMBOL_KINDS[index.kinds[at]]} ${container}${name}`;
  });
}

function counting() {
  const calls: string[] = [];
  return {
    calls,
    listFiles: async (folder: string) => {
      calls.push(folder);
      return (await indexProjectFiles(folder)).files;
    },
  };
}

const PROJECT = {
  'src/store.ts': 'export class UserStore {\n  load(id: string) {\n    return id;\n  }\n}\n',
  'app/models.py': 'class Repo:\n    def fetch(self):\n        pass\n',
  'cmd/main.go': 'package main\nfunc (s *Server) Serve() {}\n',
  'src/lib.rs': 'pub struct Config {}\nimpl Config {\n    pub fn new() -> Self {}\n}\n',
  'Services/UserService.cs':
    'public class UserService\n{\n    public async Task<User> GetAsync(int id)\n    {\n    }\n}\n',
  'src/Order.java': 'public class Order {\n    private final int id;\n}\n',
  'src/Main.kt': 'object Registry {\n    fun register() {}\n}\n',
  'Sources/Store.swift': 'protocol Store {\n    func load() -> Int\n}\n',
  'src/Invoice.php': '<?php\nclass Invoice {\n    public function total() {}\n}\n',
  'src/widget.cpp': 'class Widget {\n};\nvoid Widget::draw() const {\n}\n',
  'README.md': '# class NotCode\n',
};

describe.skipIf(!ripgrepPath())('createSymbolIndexer', () => {
  it('finds declarations in every language it knows', async () => {
    const folder = writeTree(tempDir('runova-symbols-'), PROJECT);
    const indexer = createSymbolIndexer();
    const index = full(await indexer.get(folder));
    expect(index.unavailable).toBe(false);
    expect(described(index).sort()).toEqual(
      [
        'src/store.ts class UserStore',
        'src/store.ts method UserStore.load',
        'app/models.py class Repo',
        'app/models.py method Repo.fetch',
        'cmd/main.go method Server.Serve',
        'src/lib.rs struct Config',
        'src/lib.rs method Config.new',
        'Services/UserService.cs class UserService',
        'Services/UserService.cs method UserService.GetAsync',
        'src/Order.java class Order',
        'src/Order.java field Order.id',
        'src/Main.kt class Registry',
        'src/Main.kt method Registry.register',
        'Sources/Store.swift interface Store',
        'Sources/Store.swift method Store.load',
        'src/Invoice.php class Invoice',
        'src/Invoice.php method Invoice.total',
        'src/widget.cpp class Widget',
        'src/widget.cpp method Widget.draw',
      ].sort(),
    );
  });

  it('leaves out what .gitignore leaves out', async () => {
    const folder = writeTree(tempDir('runova-symbols-'), {
      '.gitignore': 'gen/\n',
      'gen/out.ts': 'export class Generated {}\n',
      'src/a.ts': 'export class Kept {}\n',
    });
    const index = full(await createSymbolIndexer().get(folder));
    expect(index.names).toEqual(['Kept']);
  });

  it('answers "unchanged" when the window already has this version', async () => {
    const folder = writeTree(tempDir('runova-symbols-'), { 'a.ts': 'export class A {}\n' });
    const indexer = createSymbolIndexer();
    const first = full(await indexer.get(folder));
    expect(await indexer.get(folder, { sinceVersion: first.version })).toEqual({
      unchanged: true,
      version: first.version,
    });
  });

  it('rescans only what changed, and drops deleted files', async () => {
    const folder = writeTree(tempDir('runova-symbols-'), {
      'a.ts': 'export class A {}\n',
      'b.ts': 'export class B {}\n',
    });
    const indexer = createSymbolIndexer({ staleMs: 0 });
    const first = full(await indexer.get(folder));
    expect([...first.names].sort()).toEqual(['A', 'B']);

    writeFileSync(join(folder, 'a.ts'), 'export class Renamed {}\nexport function extra() {}\n');
    writeFileSync(join(folder, 'c.ts'), 'export interface C {}\n');
    rmSync(join(folder, 'b.ts'));

    const second = full(await indexer.get(folder, { fresh: true }));
    expect(second.version).toBeGreaterThan(first.version);
    expect([...second.names].sort()).toEqual(['C', 'Renamed', 'extra']);
    expect([...second.files].sort()).toEqual(['a.ts', 'c.ts']);
  });

  it('keeps the version when nothing changed', async () => {
    const folder = writeTree(tempDir('runova-symbols-'), { 'a.ts': 'export class A {}\n' });
    const indexer = createSymbolIndexer({ staleMs: 0 });
    const first = full(await indexer.get(folder));
    const again = await indexer.get(folder, { sinceVersion: first.version, fresh: true });
    expect(again).toEqual({ unchanged: true, version: first.version });
  });

  it('builds once for callers that arrive together', async () => {
    const folder = writeTree(tempDir('runova-symbols-'), { 'a.ts': 'export class A {}\n' });
    const list = counting();
    const indexer = createSymbolIndexer({ listFiles: list.listFiles });
    const [one, two] = await Promise.all([indexer.get(folder), indexer.get(folder)]);
    expect(full(one).version).toBe(full(two).version);
    expect(list.calls).toHaveLength(1);
  });

  it('stops at the symbol cap and says so', async () => {
    const lines = Array.from({ length: 50 }, (_, at) => `export function f${at}() {}`).join('\n');
    const folder = writeTree(tempDir('runova-symbols-'), { 'a.ts': `${lines}\n` });
    const index = full(await createSymbolIndexer({ maxSymbols: 10 }).get(folder));
    expect(index.names).toHaveLength(10);
    expect(index.truncated).toBe(true);
  });

  it('forgets the least recently used project', async () => {
    const a = writeTree(tempDir('runova-symbols-'), { 'a.ts': 'export class A {}\n' });
    const b = writeTree(tempDir('runova-symbols-'), { 'b.ts': 'export class B {}\n' });
    const list = counting();
    const indexer = createSymbolIndexer({ listFiles: list.listFiles, maxProjects: 1 });
    await indexer.get(a);
    await indexer.get(b);
    await indexer.get(a);
    expect(list.calls).toEqual([a, b, a]);
  });

  it('says so when ripgrep is missing', async () => {
    const folder = writeTree(tempDir('runova-symbols-'), { 'a.ts': 'export class A {}\n' });
    const index = full(await createSymbolIndexer({ rgPath: null }).get(folder));
    expect(index.unavailable).toBe(true);
    expect(index.names).toEqual([]);
  });
});
