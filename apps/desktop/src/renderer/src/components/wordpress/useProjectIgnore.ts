import type { Project, WpIgnoreList } from '@agentmat/core';
import { withoutWpIgnore } from '@agentmat/core';
import { wordPressErrorMessage } from '@shared/wordpressErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { replaceProject } from '@/components/projects/wordpress/useUnlinkWordPressProject';
import { queryKeys } from '@/lib/queryKeys';
import { addIgnoreLines, type IgnoreAddition, type IgnoreRow, ignoreRows } from './ignoreChoices';

/**
 * The files and folders a WordPress project leaves out of its pulls and deploys: what is saved,
 * and the ways to change it. Each change saves the whole list in the main process and puts the
 * project it hands back into the projects query, so every screen shows the same list. A failure
 * is returned for the caller to show where it fits (a toast, or under a field).
 */

export type IgnoreSave = { ok: true; project: Project } | { ok: false; error: string };

export interface ProjectIgnore {
  /** The list as saved; undefined when nothing is ignored. */
  ignore: WpIgnoreList | undefined;
  rows: IgnoreRow[];
  saving: boolean;
  add: (additions: readonly IgnoreAddition[]) => Promise<IgnoreSave>;
  remove: (row: Pick<IgnoreRow, 'key' | 'pattern'>) => Promise<IgnoreSave>;
  /** Puts a list back as it was, for an undo. */
  restore: (previous: WpIgnoreList | undefined) => Promise<IgnoreSave>;
}

export function useProjectIgnore(project: Project | undefined): ProjectIgnore {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const ignore = project?.wordpress?.ignore;
  const items = project?.wordpress?.items;
  const rows = useMemo(() => ignoreRows(ignore, items ?? []), [ignore, items]);

  async function save(next: WpIgnoreList | undefined): Promise<IgnoreSave> {
    if (!project) return { ok: false, error: 'That project is not loaded yet.' };
    setSaving(true);
    try {
      const updated = await window.agentmat.deployWordPress.setProjectIgnore({
        projectId: project.id,
        ignore: next ?? {},
      });
      replaceProject(queryClient, updated);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectWordPressChanges(project.id),
      });
      return { ok: true, project: updated };
    } catch (error) {
      return { ok: false, error: wordPressErrorMessage(error) };
    } finally {
      setSaving(false);
    }
  }

  return {
    ignore,
    rows,
    saving,
    add: (additions) => save(addIgnoreLines(ignore, additions)),
    remove: (row) => save(withoutWpIgnore(ignore, row.key, row.pattern)),
    restore: save,
  };
}
