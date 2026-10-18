import type { FilesChangesSnapshot, FilesPendingFile } from '@shared/deployFilesTypes';

/**
 * The pending changes as the list shows them (E23): filtered by kind, searched, grouped by the
 * folder they are in and capped, so a folder with thousands of changes stays quick to draw.
 */

export type ChangeFilter = 'all' | 'added' | 'modified' | 'deleted' | 'leftOut';

export interface FolderGroup {
  /** `''` is the deploy folder itself. */
  folder: string;
  files: FilesPendingFile[];
}

export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

export function filterCounts(snapshot: FilesChangesSnapshot): Record<ChangeFilter, number> {
  const counts = { all: 0, added: 0, modified: 0, deleted: 0, leftOut: snapshot.leftOut.length };
  for (const file of snapshot.files) {
    counts.all += 1;
    counts[file.change] += 1;
  }
  return counts;
}

export function filterFiles(
  files: readonly FilesPendingFile[],
  filter: ChangeFilter,
  query: string,
): FilesPendingFile[] {
  if (filter === 'leftOut') return [];
  const needle = query.trim().toLowerCase();
  return files.filter(
    (file) =>
      (filter === 'all' || file.change === filter) &&
      (needle === '' || file.path.toLowerCase().includes(needle)),
  );
}

export function groupByFolder(files: readonly FilesPendingFile[]): FolderGroup[] {
  const groups = new Map<string, FilesPendingFile[]>();
  for (const file of files) {
    const folder = folderOf(file.path);
    const group = groups.get(folder);
    if (group) group.push(file);
    else groups.set(folder, [file]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([folder, entries]) => ({ folder, files: entries }));
}

/** The first `limit` rows across the groups, and how many rows wait behind "Show more". */
export function limitGroups(
  groups: readonly FolderGroup[],
  limit: number,
): { groups: FolderGroup[]; hidden: number } {
  const shown: FolderGroup[] = [];
  let left = limit;
  let hidden = 0;
  for (const group of groups) {
    if (left <= 0) {
      hidden += group.files.length;
      continue;
    }
    const files = group.files.slice(0, left);
    hidden += group.files.length - files.length;
    left -= files.length;
    shown.push({ folder: group.folder, files });
  }
  return { groups: shown, hidden };
}

/** A checkbox state for a set of files: all ticked, none, or some. */
export function selectionState(
  files: readonly FilesPendingFile[],
  deselected: ReadonlySet<string>,
): boolean | 'indeterminate' {
  if (files.length === 0) return false;
  const off = files.filter((file) => deselected.has(file.path)).length;
  if (off === 0) return true;
  return off === files.length ? false : 'indeterminate';
}
