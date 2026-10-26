import type { GitChangeEntry, GitChangeStatus } from '@runova/core';

/** Splits a repo path into its folder (with the trailing slash) and file name. */
export function splitGitPath(path: string): { dir: string; name: string } {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (i < 0) return { dir: '', name: path };
  return { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

/**
 * The repository root on disk, worked out from the project folder and where that folder sits
 * inside the repository (WorkspaceGitState.projectPrefix).
 */
export function repoRootPath(folderPath: string, projectPrefix: string): string {
  const folder = folderPath.replace(/[\\/]+$/, '');
  const depth = projectPrefix ? projectPrefix.split('/').filter(Boolean).length : 0;
  const parts = folder.split(/[\\/]/);
  const separator = folder.includes('\\') ? '\\' : '/';
  return depth > 0 ? parts.slice(0, parts.length - depth).join(separator) : folder;
}

/** A repo-relative path as an absolute path, written with the folder's own separator. */
export function repoFileAbsolutePath(
  folderPath: string,
  projectPrefix: string,
  repoPath: string,
): string {
  const root = repoRootPath(folderPath, projectPrefix);
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root}${separator}${repoPath.replaceAll('/', separator)}`;
}

/**
 * A repo-relative path as an absolute path inside the project folder, in the same form the
 * explorer uses, or null when the file lives in the repository but outside the project.
 */
export function projectFilePath(
  folderPath: string,
  projectPrefix: string,
  repoPath: string,
): string | null {
  const prefix = projectPrefix ? `${projectPrefix}/` : '';
  if (prefix && !repoPath.startsWith(prefix)) return null;
  const folder = folderPath.replace(/[\\/]+$/, '');
  const separator = folder.includes('\\') ? '\\' : '/';
  return `${folder}${separator}${repoPath.slice(prefix.length).replaceAll('/', separator)}`;
}

/** A CLI's suggested commit message, without the code fences and quotes models like to add. */
export function sanitizeCommitMessage(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

export interface ChangeStatusMeta {
  letter: string;
  label: string;
  /** Text colour for the status letter. */
  className: string;
}

const STATUS_META: Record<GitChangeStatus, ChangeStatusMeta> = {
  M: { letter: 'M', label: 'Modified', className: 'text-warning' },
  A: { letter: 'A', label: 'Added', className: 'text-success' },
  D: { letter: 'D', label: 'Deleted', className: 'text-destructive' },
  R: { letter: 'R', label: 'Renamed', className: 'text-sky-400' },
  C: { letter: 'C', label: 'Copied', className: 'text-sky-400' },
  T: { letter: 'T', label: 'Type changed', className: 'text-warning' },
  U: { letter: '!', label: 'Conflict', className: 'text-destructive' },
  '?': { letter: 'U', label: 'Untracked', className: 'text-success/80' },
};

export function changeStatusMeta(status: GitChangeStatus): ChangeStatusMeta {
  return STATUS_META[status];
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
  /** Files with no line count of their own: binary, conflicted, or too big to read. */
  uncounted: number;
}

export const EMPTY_DIFF_STAT: DiffStat = { files: 0, additions: 0, deletions: 0, uncounted: 0 };

/** Adds up the line counts on a list of changed files. */
export function diffStat(entries: GitChangeEntry[]): DiffStat {
  let additions = 0;
  let deletions = 0;
  let uncounted = 0;
  for (const entry of entries) {
    if (entry.binary || (entry.additions === undefined && entry.deletions === undefined)) {
      uncounted += 1;
      continue;
    }
    additions += entry.additions ?? 0;
    deletions += entry.deletions ?? 0;
  }
  return { files: entries.length, additions, deletions, uncounted };
}

export function sumDiffStats(stats: DiffStat[]): DiffStat {
  return stats.reduce(
    (total, stat) => ({
      files: total.files + stat.files,
      additions: total.additions + stat.additions,
      deletions: total.deletions + stat.deletions,
      uncounted: total.uncounted + stat.uncounted,
    }),
    EMPTY_DIFF_STAT,
  );
}

/** Short enough for the panel: exact under ten thousand, then 12.3k and 1.2M. */
export function formatLineCount(value: number): string {
  if (value < 10_000) return value.toLocaleString();
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * How the five blocks of a diff bar are coloured: green for additions, red for deletions,
 * split by share of the change. A side with any lines at all keeps at least one block.
 */
export function diffBarBlocks(additions: number, deletions: number): ('add' | 'del' | 'none')[] {
  const total = additions + deletions;
  if (total === 0) return Array.from({ length: 5 }, () => 'none' as const);
  let added = Math.round((additions / total) * 5);
  if (additions > 0 && added === 0) added = 1;
  if (deletions > 0 && added === 5) added = 4;
  return Array.from({ length: 5 }, (_, i) => (i < added ? 'add' : 'del'));
}
