import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildTestTree,
  detectTestProjects,
  IGNORED_TEST_DIRS,
  manifestPathsToRead,
  type TestDiscovery,
  testFilesFor,
} from '@runova/core';

/**
 * Reads a workspace for the Tests panel: which files exist, which manifests say what frameworks
 * are in use, and what the test files declare. Everything past listing and reading files is the
 * pure logic in @runova/core.
 */

const IGNORED = new Set(IGNORED_TEST_DIRS);
const MAX_MANIFEST_BYTES = 1_000_000;
const READ_CONCURRENCY = 32;

export interface ListOptions {
  /** Use `git ls-files` when the folder is a repository, so ignored files stay out. */
  preferGit?: boolean;
  maxFiles?: number;
}

export async function listWorkspaceFiles(
  folderPath: string,
  options: ListOptions = {},
): Promise<{ files: string[]; truncated: boolean }> {
  const maxFiles = options.maxFiles ?? 200_000;
  if (options.preferGit !== false) {
    const fromGit = await gitFiles(folderPath);
    if (fromGit) {
      const files = fromGit.filter(
        (file) =>
          !file
            .split('/')
            .slice(0, -1)
            .some((part) => IGNORED.has(part)),
      );
      return { files: files.slice(0, maxFiles), truncated: files.length > maxFiles };
    }
  }
  return walk(folderPath, maxFiles);
}

function gitFiles(folderPath: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: folderPath, maxBuffer: 256 * 1024 * 1024, timeout: 30_000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        resolve(
          stdout
            .toString()
            .split('\0')
            .filter(Boolean)
            .map((file) => file.replace(/\\/g, '/')),
        );
      },
    );
  });
}

async function walk(
  folderPath: string,
  maxFiles: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue: string[] = [''];
  while (queue.length > 0) {
    const rel = queue.shift() ?? '';
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(join(folderPath, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name) && !entry.name.startsWith('.')) queue.push(path);
      } else if (entry.isFile()) {
        if (files.length >= maxFiles) return { files, truncated: true };
        files.push(path);
      }
    }
  }
  return { files, truncated: false };
}

async function readSmallFiles(
  folderPath: string,
  paths: readonly string[],
  maxBytes: number,
): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const path = paths[next];
      next += 1;
      const full = join(folderPath, path);
      try {
        const info = await stat(full);
        if (!info.isFile() || info.size > maxBytes) continue;
        contents[path] = await readFile(full, 'utf-8');
      } catch {
        // Deleted since it was listed, or unreadable: it simply has no tests to show.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker));
  return contents;
}

export interface DiscoverOptions {
  maxTestFiles?: number;
  maxFileBytes?: number;
}

export async function discoverWorkspaceTests(
  folderPath: string,
  options: DiscoverOptions = {},
): Promise<TestDiscovery> {
  const maxTestFiles = options.maxTestFiles ?? 4_000;
  const maxFileBytes = options.maxFileBytes ?? 512_000;
  const listed = await listWorkspaceFiles(folderPath);
  const manifests = manifestPathsToRead(listed.files).filter(
    (file) =>
      !file
        .split('/')
        .slice(0, -1)
        .some((part) => IGNORED.has(part)),
  );
  const projects = detectTestProjects({
    files: listed.files,
    contents: await readSmallFiles(folderPath, manifests, MAX_MANIFEST_BYTES),
  });
  if (projects.length === 0) return { projects: [], tree: [], truncated: false };

  const candidates = [
    ...new Set(Object.values(testFilesFor(projects, listed.files)).flat()),
  ].sort();
  const truncated = listed.truncated || candidates.length > maxTestFiles;
  const contents = await readSmallFiles(
    folderPath,
    candidates.slice(0, maxTestFiles),
    maxFileBytes,
  );
  return { projects, tree: buildTestTree(projects, contents), truncated };
}
