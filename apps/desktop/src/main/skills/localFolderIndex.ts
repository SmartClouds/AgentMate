import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, posix, sep } from 'node:path';
import type { Skill, SkillRepositoryIndex } from '@runova/core';

/**
 * Builds a repository index by scanning a folder of skills, for folders that have no
 * `repository.json` of their own. Two layouts are recognised, both of which people actually keep
 * their skills in:
 *
 *   - a directory holding a `SKILL.md` (plus any support files next to it), the layout Claude Code
 *     and the `skills` CLI use;
 *   - a loose `.md` file at the top level, which becomes a one-file skill.
 *
 * Nested directories are searched a few levels deep, so wrappers like `skills/<name>/SKILL.md` or
 * `category/<name>/SKILL.md` are picked up too.
 */

const SKILL_ENTRY_FILE = 'skill.md';
const MAX_SCAN_DEPTH = 4;
const MAX_FILES_PER_SKILL = 200;

const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  '.runova',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  'coverage',
]);

/** Docs that live alongside skills in the same folder but are not skills themselves. */
const NON_SKILL_MARKDOWN = new Set([
  'readme.md',
  'license.md',
  'licence.md',
  'changelog.md',
  'contributing.md',
  'agents.md',
  'claude.md',
  'index.md',
]);

/**
 * Skill files are copied as UTF-8 text on install, so binaries would be mangled. Extensions that
 * are never text are left out of the index instead of being silently corrupted.
 */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.icns',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.wav',
  '.avi',
  '.webm',
  '.psd',
  '.sqlite',
  '.db',
]);

type Frontmatter = Record<string, string | string[]>;

/**
 * Reads the YAML frontmatter block at the top of a skill file. This is a small subset of YAML
 * (scalars, `>`/`|` blocks, inline and dashed lists), which is all skill frontmatter uses, so the
 * main process does not need a YAML dependency for it.
 */
export function parseSkillFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};

  const lines = text.slice(4, end).split('\n');
  const result: Frontmatter = {};
  let key: string | null = null;
  let blockMode: 'folded' | 'literal' | 'plain' | null = null;
  let buffer: string[] = [];
  let list: string[] | null = null;

  const flush = (): void => {
    if (!key) return;
    if (list) {
      result[key] = list;
    } else {
      const joined =
        blockMode === 'literal' ? buffer.join('\n').trimEnd() : buffer.join(' ').trim();
      if (joined) result[key] = joined;
    }
    key = null;
    blockMode = null;
    buffer = [];
    list = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      if (blockMode === 'literal') buffer.push('');
      continue;
    }

    const indented = /^\s/.test(line);
    if (indented && key) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        list ??= [];
        list.push(stripQuotes(trimmed.slice(2).trim()));
      } else {
        buffer.push(blockMode === 'literal' ? line.replace(/^\s{1,4}/, '') : trimmed);
      }
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    flush();
    key = match[1].toLowerCase();
    const value = match[2].trim();
    if (value === '>' || value === '>-' || value === '>+') {
      blockMode = 'folded';
    } else if (value === '|' || value === '|-' || value === '|+') {
      blockMode = 'literal';
    } else if (value.startsWith('[') && value.endsWith(']')) {
      list = splitInlineList(value);
    } else if (value) {
      blockMode = 'plain';
      buffer.push(stripQuotes(value));
    } else {
      blockMode = 'plain';
    }
  }
  flush();

  return result;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^(".*"|'.*')$/s.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

function splitInlineList(value: string): string[] {
  return value
    .slice(1, -1)
    .split(',')
    .map((item) => stripQuotes(item))
    .filter(Boolean);
}

function asString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(', ');
  return value?.trim() || undefined;
}

function asList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Skill ids become directory names under agent skills folders (e.g. `.claude/skills/`), so keep them to safe characters. */
function toSkillId(name: string): string {
  return (
    name
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .toLowerCase() || 'skill'
  );
}

function humanize(id: string): string {
  return id
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** First real paragraph of the body, used when the frontmatter has no description. */
function firstParagraph(body: string): string {
  const withoutFrontmatter = body.replace(/^---\n[\s\S]*?\n---\n?/, '');
  let headingFallback = '';
  for (const block of withoutFrontmatter.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const text = trimmed
      .replace(/^#+\s*/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    // A title on its own says little, so keep looking for prose and only fall back to it.
    if (trimmed.startsWith('#')) {
      headingFallback ||= text;
      continue;
    }
    return text.length > 300 ? `${text.slice(0, 297)}…` : text;
  }
  return headingFallback;
}

function toPosixPath(relativePath: string): string {
  return relativePath.split(sep).join(posix.sep);
}

/**
 * Skill folders are often symlinked in from somewhere else (a dotfiles repo, a shared drive), and
 * a symlink reports as neither a file nor a directory on its own, so it is followed here.
 */
async function entryKind(dir: string, entry: Dirent): Promise<'dir' | 'file' | 'other'> {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return 'other';
  try {
    const stats = await stat(join(dir, entry.name));
    return stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other';
  } catch {
    // A link pointing at something that no longer exists.
    return 'other';
  }
}

/** Every text file under a skill directory, as paths relative to that directory. */
async function collectSkillFiles(skillDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (files.length >= MAX_FILES_PER_SKILL || depth > MAX_SCAN_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_FILES_PER_SKILL) return;
      if (entry.name.startsWith('.')) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const kind = await entryKind(dir, entry);
      if (kind === 'dir') {
        if (IGNORED_DIR_NAMES.has(entry.name.toLowerCase())) continue;
        await walk(join(dir, entry.name), relativePath, depth + 1);
      } else if (kind === 'file' && !BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(relativePath);
      }
    }
  }

  await walk(skillDir, '', 0);
  return files;
}

async function skillFromDirectory(
  rootDir: string,
  skillDir: string,
  entryFileName: string,
): Promise<Skill | null> {
  const files = await collectSkillFiles(skillDir);
  if (files.length === 0) return null;

  const raw = await readFile(join(skillDir, entryFileName), 'utf-8');
  const relativeDir = toPosixPath(skillDir.slice(rootDir.length + 1));
  return buildSkill({
    raw,
    fallbackId: basename(skillDir),
    files: files.map((path) => ({ path, url: relativeDir ? `${relativeDir}/${path}` : path })),
  });
}

async function skillFromFile(rootDir: string, filePath: string): Promise<Skill> {
  const raw = await readFile(filePath, 'utf-8');
  const relativePath = toPosixPath(filePath.slice(rootDir.length + 1));
  return buildSkill({
    raw,
    fallbackId: basename(filePath, extname(filePath)),
    // A loose markdown file installs as `<skill-id>/SKILL.md`, the layout agents expect.
    files: [{ path: 'SKILL.md', url: relativePath }],
  });
}

function buildSkill(params: { raw: string; fallbackId: string; files: Skill['files'] }): Skill {
  const frontmatter = parseSkillFrontmatter(params.raw);
  const id = toSkillId(asString(frontmatter.name) ?? params.fallbackId);
  const description = asString(frontmatter.description) ?? firstParagraph(params.raw);
  const tags = asList(frontmatter.tags ?? frontmatter.keywords);

  return {
    id,
    name: asString(frontmatter.title) ?? humanize(asString(frontmatter.name) ?? params.fallbackId),
    description: description || 'No description in this skill’s frontmatter.',
    category: asString(frontmatter.category) ?? 'Local',
    tags,
    author: asString(frontmatter.author) ?? 'Local folder',
    version: asString(frontmatter.version) ?? '1.0.0',
    popularity: 0,
    dependencies: asList(frontmatter.dependencies),
    compatibility: asList(frontmatter.compatibility ?? frontmatter.agents),
    ...(asString(frontmatter.documentationurl) || asString(frontmatter.homepage)
      ? {
          documentationUrl: (asString(frontmatter.documentationurl) ??
            asString(frontmatter.homepage))!,
        }
      : {}),
    files: params.files,
  };
}

/** The SKILL.md in a directory listing, whatever case it was written in. */
function findEntryFile(entries: Dirent[]): Dirent | undefined {
  return entries.find(
    (entry) => !entry.isDirectory() && entry.name.toLowerCase() === SKILL_ENTRY_FILE,
  );
}

/**
 * Scans `rootDir` for skills. Returns an index even when nothing is found, so callers can decide
 * how to report an empty folder.
 */
export async function scanSkillFolder(rootDir: string): Promise<SkillRepositoryIndex> {
  const skills: Skill[] = [];
  const seenIds = new Set<string>();

  const addSkill = (skill: Skill | null): void => {
    if (!skill) return;
    // Two folders can carry the same skill name; keep both by numbering the later ones.
    let id = skill.id;
    for (let suffix = 2; seenIds.has(id); suffix += 1) id = `${skill.id}-${suffix}`;
    seenIds.add(id);
    skills.push({ ...skill, id });
  };

  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const entryFile = findEntryFile(entries);
    if (entryFile && dir !== rootDir) {
      addSkill(await skillFromDirectory(rootDir, dir, entryFile.name));
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const kind = await entryKind(dir, entry);
      if (kind === 'dir') {
        if (IGNORED_DIR_NAMES.has(entry.name.toLowerCase())) continue;
        if (depth < MAX_SCAN_DEPTH) await walk(join(dir, entry.name), depth + 1);
      } else if (
        kind === 'file' &&
        extname(entry.name).toLowerCase() === '.md' &&
        !NON_SKILL_MARKDOWN.has(entry.name.toLowerCase())
      ) {
        addSkill(await skillFromFile(rootDir, join(dir, entry.name)));
      }
    }
  }

  // A folder that is itself one skill (SKILL.md sitting at the top) counts as a single skill.
  const rootEntries = await readdir(rootDir, { withFileTypes: true });
  const rootEntryFile = findEntryFile(rootEntries);
  if (rootEntryFile) {
    addSkill(await skillFromDirectory(rootDir, rootDir, rootEntryFile.name));
  } else {
    await walk(rootDir, 0);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));

  return {
    name: basename(rootDir) || rootDir,
    description: `Skills found in ${rootDir}`,
    skills,
  };
}
