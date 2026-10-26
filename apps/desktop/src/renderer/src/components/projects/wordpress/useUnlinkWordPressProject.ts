import type { Project } from '@runova/core';
import { wordPressErrorMessage } from '@shared/wordpressErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { LinkOff } from '@/components/icons';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';

/**
 * Turns a WordPress project back into a regular one after asking: the link and the last sync go,
 * every file stays. Shared by the project's WordPress section and its Edit project form.
 */
export function useUnlinkWordPressProject(): {
  unlinking: boolean;
  /** Resolves true once the project is unlinked; false when the user said no or it failed. */
  unlink: (project: Project, onUnlinked?: () => void) => Promise<boolean>;
} {
  const queryClient = useQueryClient();
  const [unlinking, setUnlinking] = useState(false);

  async function unlink(project: Project, onUnlinked?: () => void): Promise<boolean> {
    const ok = await confirmDialog({
      title: 'Unlink this project from the site?',
      description:
        "It goes back to being a regular project and every file stays in the folder. Runova stops pulling from and deploying to the site, forgets what it last synced, and takes the site's details out of the standing prompt.",
      confirmLabel: 'Unlink',
      icon: LinkOff,
    });
    if (!ok) return false;
    setUnlinking(true);
    try {
      const updated = await window.runova.deployWordPress.unlinkProject(project.id);
      // The WordPress section goes with the link, so the caller leaves it first.
      onUnlinked?.();
      replaceProject(queryClient, updated);
      toast.success(
        'Unlinked. It is a regular project again, with every file still in its folder.',
      );
      return true;
    } catch (error) {
      toast.error(wordPressErrorMessage(error));
      return false;
    } finally {
      setUnlinking(false);
    }
  }

  return { unlinking, unlink };
}

export function replaceProject(
  queryClient: ReturnType<typeof useQueryClient>,
  updated: Project | null | undefined,
): void {
  if (updated?.id) {
    queryClient.setQueryData<Project[]>(queryKeys.projects, (prev) =>
      prev?.map((entry) => (entry.id === updated.id ? updated : entry)),
    );
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
}
