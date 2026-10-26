import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, posix, sep } from 'node:path';
import type { SkillAuditFileInput, SkillAuditFinding } from '@runova/core';
import {
  buildSkillAuditPrompt,
  parseSkillAuditReview,
  scanSkillFiles,
  scoreSkillFindings,
  sortFindings,
} from '@runova/core';
import type {
  RunSkillAuditResult,
  SkillAuditRecord,
  SkillAuditSourceKind,
} from '../../shared/apiTypes';
import { runHeadlessCliPrompt } from '../cli/headlessPrompt';
import { skillAuditDb } from '../skillAuditDb';

/**
 * Reading limits. A skill is text, so anything past these is either not a skill or not something
 * a reviewer would read anyway, and the audit says so in the report rather than stalling on it.
 */
const MAX_FILES_PER_AUDIT = 40;
const MAX_BYTES_PER_FILE = 400_000;
const MAX_TOTAL_BYTES = 2_000_000;

/** Extensions that are never text, so scanning them would only produce noise. */
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

export function isScannableFile(path: string): boolean {
  return !BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

function toPosixPath(relativePath: string): string {
  return relativePath.split(sep).join(posix.sep);
}

/** Caps a file's content and marks the cut, so a truncated scan is never mistaken for a clean one. */
function capContent(content: string): string {
  if (content.length <= MAX_BYTES_PER_FILE) return content;
  return `${content.slice(0, MAX_BYTES_PER_FILE)}\n… (file truncated by the security scan)`;
}

/** Walks an installed skill folder and returns every text file inside it. */
export async function readSkillDirFiles(skillDir: string): Promise<SkillAuditFileInput[]> {
  const files: SkillAuditFileInput[] = [];
  let totalBytes = 0;

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (files.length >= MAX_FILES_PER_AUDIT || totalBytes >= MAX_TOTAL_BYTES || depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES_PER_AUDIT || totalBytes >= MAX_TOTAL_BYTES) return;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, relativePath, depth + 1);
        continue;
      }
      // Dotfiles are included on purpose here: a payload dropped in a skill folder is more
      // likely to be hidden than a legitimate support file is.
      if (!entry.isFile() || !isScannableFile(entry.name)) continue;
      const content = await readFile(full, 'utf-8').catch(() => null);
      if (content === null) continue;
      totalBytes += content.length;
      files.push({ path: toPosixPath(relativePath), content: capContent(content) });
    }
  }

  await walk(skillDir, '', 0);
  return files;
}

export async function directoryExists(path: string): Promise<boolean> {
  return stat(path)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
}

/** How many skills a browse of a folder or repository will list before it stops counting. */
const MAX_DISCOVERED_SKILLS = 60;
const SKILL_ENTRY_FILE = 'skill.md';

/** Docs that sit beside skills without being skills, mirroring the local folder indexer. */
const NON_SKILL_MARKDOWN = new Set([
  'readme.md',
  'license.md',
  'licence.md',
  'changelog.md',
  'contributing.md',
  'agents.md',
  'claude.md',
  'index.md',
  'security.md',
  'code_of_conduct.md',
]);

/** A skill found by browsing a location, before anything is downloaded or scanned. */
export interface DiscoveredSkill {
  name: string;
  /** Directory holding the SKILL.md, or the markdown file itself for one-file skills. */
  location: string;
}

/**
 * Finds the skills in a folder: directories holding a SKILL.md, plus loose markdown files, the
 * same two layouts the marketplace's folder repositories recognise. A folder that is itself one
 * skill answers with just that skill.
 */
export async function findLocalSkills(root: string): Promise<DiscoveredSkill[]> {
  const found: DiscoveredSkill[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (found.length >= MAX_DISCOVERED_SKILLS || depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const entryFile = entries.find(
      (entry) => !entry.isDirectory() && entry.name.toLowerCase() === SKILL_ENTRY_FILE,
    );
    if (entryFile) {
      found.push({ name: basename(dir), location: dir });
      return;
    }

    for (const entry of entries) {
      if (found.length >= MAX_DISCOVERED_SKILLS) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (
        entry.isFile() &&
        extname(entry.name).toLowerCase() === '.md' &&
        !NON_SKILL_MARKDOWN.has(entry.name.toLowerCase())
      ) {
        found.push({ name: basename(entry.name, extname(entry.name)), location: full });
      }
    }
  }

  await walk(root, 0);
  return found;
}

/** Reads a skill that is a folder, or one that is a single markdown file. */
export async function readSkillPathFiles(path: string): Promise<SkillAuditFileInput[]> {
  if (await directoryExists(path)) return readSkillDirFiles(path);
  const content = await readFile(path, 'utf-8').catch(() => null);
  if (content === null) return [];
  return [{ path: basename(path), content: capContent(content) }];
}

interface GithubTreeEntry {
  path: string;
  type: string;
}

function githubTreeError(status: number, repo: string, ref: string): string {
  if (status === 403 || status === 429) {
    return 'GitHub rate-limited the request. Unauthenticated calls are capped per hour, so try again later.';
  }
  if (status === 404) {
    return ref === 'HEAD'
      ? `GitHub has no repository at ${repo}, or it is private.`
      : `GitHub has no "${ref}" in ${repo}, or the repository is private.`;
  }
  return `Could not read ${repo} from GitHub: HTTP ${status}.`;
}

/**
 * Trees are cached briefly because checking a repository of twenty skills would otherwise send
 * twenty identical requests: once to list them and once per skill scanned. GitHub allows 60
 * unauthenticated API calls an hour, so one "Check all" could burn the lot. Raw file downloads
 * are not part of that budget, so only the tree is cached.
 */
const TREE_CACHE_TTL_MS = 5 * 60_000;
const TREE_CACHE_MAX_ENTRIES = 20;
const treeCache = new Map<string, { entries: GithubTreeEntry[]; fetchedAt: number }>();

/** Every file in a repository at one ref, which is one request rather than one per directory. */
async function fetchGithubTree(repo: string, ref: string): Promise<GithubTreeEntry[]> {
  const cacheKey = `${repo}@${ref}`;
  const cached = treeCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TREE_CACHE_TTL_MS) return cached.entries;

  const response = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers: { 'User-Agent': 'Runova', Accept: 'application/vnd.github+json' } },
  );
  if (!response.ok) throw new Error(githubTreeError(response.status, repo, ref));
  const tree = (await response.json()) as { tree?: GithubTreeEntry[] };
  const entries = (tree.tree ?? []).filter((entry) => entry.type === 'blob');

  // Oldest out first, so a long session browsing many repos cannot grow this without bound.
  if (treeCache.size >= TREE_CACHE_MAX_ENTRIES) {
    const oldest = treeCache.keys().next();
    if (!oldest.done) treeCache.delete(oldest.value);
  }
  treeCache.set(cacheKey, { entries, fetchedAt: Date.now() });
  return entries;
}

function directoryOfPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/**
 * Lists the skills a repository holds under `subPath` (the whole repository when that is empty),
 * so a pasted GitHub link can be browsed before anything is downloaded.
 */
export async function findGithubSkills(
  repo: string,
  ref: string,
  subPath: string,
): Promise<DiscoveredSkill[]> {
  const entries = await fetchGithubTree(repo, ref);
  const prefix = subPath ? `${subPath.replace(/\/+$/, '')}/` : '';
  let inScope = entries.filter(
    (entry) => !prefix || entry.path === subPath || entry.path.startsWith(prefix),
  );

  // Links go stale and repositories reorganise: a path like `<repo>/foo` that no longer exists
  // usually means the skill moved to `skills/foo`. Rather than reporting nothing, look for a
  // skill folder of that name anywhere in the repository.
  if (inScope.length === 0 && subPath) {
    const wanted = basename(subPath).toLowerCase();
    inScope = entries.filter((entry) => {
      const lower = entry.path.toLowerCase();
      return lower.includes(`/${wanted}/`) || lower.startsWith(`${wanted}/`);
    });
  }

  const skills: DiscoveredSkill[] = [];
  const seen = new Set<string>();

  for (const entry of inScope) {
    const lower = entry.path.toLowerCase();
    if (lower.endsWith(`/${SKILL_ENTRY_FILE}`) || lower === SKILL_ENTRY_FILE) {
      const dir = directoryOfPath(entry.path);
      if (seen.has(dir)) continue;
      seen.add(dir);
      // A SKILL.md at the repository root means the repository is the skill.
      skills.push({ name: dir ? basename(dir) : repo.split('/')[1], location: dir });
    }
    if (skills.length >= MAX_DISCOVERED_SKILLS) break;
  }

  // Repos that publish skills as loose markdown files have no SKILL.md to find.
  if (skills.length === 0) {
    for (const entry of inScope) {
      const name = basename(entry.path);
      if (extname(name).toLowerCase() !== '.md') continue;
      if (NON_SKILL_MARKDOWN.has(name.toLowerCase())) continue;
      skills.push({ name: basename(name, extname(name)), location: entry.path });
      if (skills.length >= MAX_DISCOVERED_SKILLS) break;
    }
  }

  return skills;
}

/** Raw file downloads are not part of the API rate limit, so a few can run at once. */
const GITHUB_DOWNLOAD_CONCURRENCY = 6;

/**
 * Downloads the files of one skill inside a repository, given the tree entry paths it owns.
 * Order is preserved so the report reads the same way every time.
 */
async function downloadGithubFiles(
  repo: string,
  ref: string,
  paths: string[],
  basePath: string,
): Promise<SkillAuditFileInput[]> {
  const results: (SkillAuditFileInput | null)[] = new Array(paths.length).fill(null);
  let next = 0;
  let totalBytes = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= paths.length || totalBytes >= MAX_TOTAL_BYTES) return;
      const path = paths[index];
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const response = await fetch(
        `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${encoded}`,
        { headers: { 'User-Agent': 'Runova' } },
      ).catch(() => null);
      if (!response?.ok) continue;
      const content = await response.text();
      totalBytes += content.length;
      results[index] = {
        path: basePath && path.startsWith(basePath) ? path.slice(basePath.length) : path,
        content: capContent(content),
      };
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(GITHUB_DOWNLOAD_CONCURRENCY, paths.length) }, worker),
  );

  return results.filter((file): file is SkillAuditFileInput => file !== null);
}

/**
 * Reads one skill out of a repository by its exact location: a directory (everything under it) or
 * a single markdown file. Used for pasted GitHub links, where the location is already known.
 */
export async function fetchGithubPathFiles(
  repo: string,
  ref: string,
  location: string,
): Promise<SkillAuditFileInput[]> {
  const entries = await fetchGithubTree(repo, ref);
  const exact = entries.find((entry) => entry.path === location);

  // A location that names a file is a one-file skill; otherwise it is the skill's folder.
  const paths = exact
    ? [exact.path]
    : entries
        .filter(
          (entry) =>
            (location === '' || entry.path.startsWith(`${location.replace(/\/+$/, '')}/`)) &&
            isScannableFile(entry.path),
        )
        .map((entry) => entry.path)
        .slice(0, MAX_FILES_PER_AUDIT);

  if (paths.length === 0) {
    throw new Error(`Nothing to scan at ${location || 'the repository root'} in ${repo}.`);
  }

  const basePath = exact ? directoryOfPath(exact.path) : location.replace(/\/+$/, '');
  const files = await downloadGithubFiles(repo, ref, paths, basePath ? `${basePath}/` : '');
  if (files.length === 0) throw new Error(`Could not download the files from ${repo}.`);
  return files;
}

/**
 * Pulls a skills.sh skill's files straight from the GitHub repo that publishes it, so a skill can
 * be checked before it is installed. Repos nest skills differently (`<name>/SKILL.md`,
 * `skills/<name>/SKILL.md`, and so on), so the tree is searched for the entry file instead of a
 * path being guessed.
 */
export async function fetchGithubSkillFiles(
  repo: string,
  skillName: string,
): Promise<SkillAuditFileInput[]> {
  const entries = await fetchGithubTree(repo, 'HEAD');
  const wanted = skillName.toLowerCase();

  const entryFile = entries.find((entry) => {
    const path = entry.path.toLowerCase();
    return (
      path === `${wanted}/${SKILL_ENTRY_FILE}` || path.endsWith(`/${wanted}/${SKILL_ENTRY_FILE}`)
    );
  });

  // A skill folder is the common case; a repo that ships the skill as one loose markdown file
  // (`<name>.md`) is the fallback.
  const looseFile = entryFile
    ? null
    : entries.find((entry) => {
        const path = entry.path.toLowerCase();
        return path === `${wanted}.md` || path.endsWith(`/${wanted}.md`);
      });

  if (!entryFile && !looseFile) {
    throw new Error(
      `Could not find "${skillName}" in ${repo}. The repository may have renamed or removed it.`,
    );
  }

  const dir = entryFile ? `${directoryOfPath(entryFile.path)}/` : '';
  const paths = entryFile
    ? entries
        .filter((entry) => entry.path.startsWith(dir) && isScannableFile(entry.path))
        .map((entry) => entry.path)
        .slice(0, MAX_FILES_PER_AUDIT)
    : [looseFile!.path];

  const files = await downloadGithubFiles(repo, 'HEAD', paths, dir);
  if (files.length === 0) throw new Error(`Could not download "${skillName}" from ${repo}.`);
  return files;
}

export interface SkillAuditRunInput {
  skillId: string;
  skillName: string;
  sourceKind: SkillAuditSourceKind;
  sourceLabel: string;
  projectId: string | null;
  files: SkillAuditFileInput[];
  deepReview: boolean;
  cliId?: string | null;
  requestId?: string;
  /** Working directory for the CLI review. The CLI is told not to touch it. */
  cwd: string;
}

/**
 * Scans a skill, optionally asks an agent CLI for a second opinion, and stores the result.
 *
 * The static scan always decides the score and verdict on its own. A CLI review can add findings
 * and its own summary, and it can pull the verdict down, but it can never pull it up: a model
 * saying "looks fine" is not a reason to discard a rule that matched a real line.
 */
export async function runSkillAudit(input: SkillAuditRunInput): Promise<RunSkillAuditResult> {
  if (input.files.length === 0) {
    return { ok: false, record: null, error: 'This skill has no readable files to scan.' };
  }

  const staticFindings = scanSkillFiles(input.files);
  let findings: SkillAuditFinding[] = staticFindings;
  let cliName: string | null = null;
  let aiSummary: string | null = null;
  let aiError: string | null = null;

  if (input.deepReview) {
    const prompt = buildSkillAuditPrompt({
      skillName: input.skillName,
      sourceLabel: input.sourceLabel,
      files: input.files,
      staticFindings,
    });
    const result = await runHeadlessCliPrompt(prompt, input.cwd, {
      requestId: input.requestId,
      preferredCliId: input.cliId ?? null,
    });
    cliName = result.cliName;

    if (result.cancelled) return { ok: false, record: null, cancelled: true };

    if (!result.ok) {
      aiError = result.error ?? 'The CLI review did not return an answer.';
    } else {
      const review = parseSkillAuditReview(result.text);
      aiSummary = review.summary || null;
      findings = sortFindings([...staticFindings, ...review.findings]);
      if (review.findings.length === 0 && !review.summary) {
        aiError = `${result.cliName ?? 'The CLI'} returned an answer that could not be read as a review.`;
      }
    }
  }

  const scored = scoreSkillFindings(findings);
  const verdict = worseVerdict(scored.verdict, deepReviewVerdictFloor(findings));

  const record = skillAuditDb.add({
    skillId: input.skillId,
    skillName: input.skillName,
    sourceKind: input.sourceKind,
    sourceLabel: input.sourceLabel,
    projectId: input.projectId,
    verdict,
    score: scored.score,
    findings,
    filesScanned: input.files.length,
    bytesScanned: input.files.reduce((total, file) => total + file.content.length, 0),
    deepReview: input.deepReview,
    cliName,
    aiSummary,
    aiError,
  });

  return { ok: true, record };
}

type Verdict = SkillAuditRecord['verdict'];

const VERDICT_RANK: Record<Verdict, number> = { safe: 0, caution: 1, risky: 2, dangerous: 3 };

function worseVerdict(verdict: Verdict, other: Verdict | null): Verdict {
  if (!other) return verdict;
  return VERDICT_RANK[other] > VERDICT_RANK[verdict] ? other : verdict;
}

/**
 * A CLI finding that is worse than anything the rules caught still has to move the verdict, since
 * the score only knows about rule weights. Returns null when nothing needs raising.
 */
function deepReviewVerdictFloor(findings: SkillAuditFinding[]): Verdict | null {
  const aiFindings = findings.filter((f) => f.origin === 'ai');
  if (aiFindings.some((f) => f.severity === 'critical')) return 'dangerous';
  if (aiFindings.some((f) => f.severity === 'high')) return 'risky';
  return null;
}
