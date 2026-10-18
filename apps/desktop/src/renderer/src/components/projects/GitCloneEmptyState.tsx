import { browsableRepoUrl, isClonableGithubUrl, normalizeCloneUrl } from '@agentmat/core';
import type { CloneProjectResult } from '@shared/apiTypes';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { CloudDownload, GitBranch, Spinner } from '@/components/icons';
import { SectionEmptyState } from '@/components/projects/ProjectDetailChrome';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';

/** The button carries its own spinner, so the clone opts out of the app-wide loading overlay. */
const CLONE_META = { silentLoading: true } as const;

/** `owner/repo` for a GitHub address, which is what a button has room for. */
function repoLabel(repoUrl: string): string {
  const normalized = normalizeCloneUrl(repoUrl);
  return normalized ? normalized.replace(/^https:\/\/github\.com\//, '') : repoUrl;
}

/**
 * The Git tab for a project whose folder isn't a repository yet. When the project has a GitHub
 * address (or the user types one) this gets that repo onto the computer: a clone into an empty
 * folder, or, after asking, connecting a folder that already holds the files. Starting a brand
 * new repository stays available through `onInitialize`.
 */
export function GitCloneEmptyState({
  projectId,
  repoUrl,
  onInitialize,
}: {
  projectId: string;
  repoUrl: string;
  onInitialize: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draftUrl, setDraftUrl] = useState('');

  const savedClonable = isClonableGithubUrl(repoUrl);

  const cloneMutation = useMutation({
    mutationFn: async ({
      url,
      attach,
    }: {
      url: string;
      attach: boolean;
    }): Promise<{ url: string; result: CloneProjectResult }> => {
      const result = await window.agentmat.git.cloneProject({ projectId, repoUrl: url, attach });
      return { url, result };
    },
    onSuccess: async ({ url, result }) => {
      if (result.needsAttachConfirm) {
        const confirmed = await confirmDialog({
          title: `Connect this folder to ${repoLabel(url)}?`,
          description:
            'This folder already has files. They stay exactly as they are, and anything that differs from GitHub shows up as a change on this tab.',
          icon: GitBranch,
          confirmLabel: 'Connect',
        });
        if (confirmed) cloneMutation.mutate({ url, attach: true });
        return;
      }
      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      toast.success(result.message);
      setDialogOpen(false);
      const link = browsableRepoUrl(url);
      if (link !== repoUrl) {
        // The address that worked becomes the project's repository link.
        await window.agentmat.projects.update(projectId, { repoUrl: link });
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(projectId) });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Clone failed.');
    },
    meta: CLONE_META,
  });

  const pending = cloneMutation.isPending;
  const draftClonable = isClonableGithubUrl(draftUrl);

  function openUrlDialog(): void {
    setDraftUrl(repoUrl);
    setDialogOpen(true);
  }

  const cloneSaved = (
    <Button
      disabled={pending}
      onClick={() => cloneMutation.mutate({ url: repoUrl, attach: false })}
    >
      {pending ? (
        <Spinner className="h-4 w-4 animate-spin" />
      ) : (
        <CloudDownload className="h-4 w-4" />
      )}
      Clone {repoLabel(repoUrl)}
    </Button>
  );

  return (
    <>
      <SectionEmptyState
        icon={GitBranch}
        title={
          savedClonable
            ? "This project's GitHub repository isn't on this computer yet"
            : "This folder isn't a git repository yet"
        }
        description={
          savedClonable
            ? 'Clone it from GitHub to get the code, history and branches. A private repo needs the GitHub CLI signed in (gh auth login).'
            : 'Clone an existing GitHub repository into this folder, or start a new one on a master branch and publish it to GitHub without leaving the app.'
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {savedClonable ? (
              <>
                {cloneSaved}
                <Button variant="outline" disabled={pending} onClick={onInitialize}>
                  <GitBranch className="h-4 w-4" /> Initialize a new repository
                </Button>
              </>
            ) : (
              <>
                <Button disabled={pending} onClick={onInitialize}>
                  <GitBranch className="h-4 w-4" /> Initialize repository
                </Button>
                <Button variant="outline" disabled={pending} onClick={openUrlDialog}>
                  <CloudDownload className="h-4 w-4" /> Clone from GitHub…
                </Button>
              </>
            )}
          </div>
        }
      />

      <Dialog open={dialogOpen} onOpenChange={(open) => !pending && setDialogOpen(open)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Clone from GitHub</DialogTitle>
            <DialogDescription>
              The repository is cloned into this project's folder. If the folder already has files,
              you'll be asked before they are connected to it.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (draftClonable && !pending) {
                cloneMutation.mutate({ url: draftUrl.trim(), attach: false });
              }
            }}
          >
            <Label htmlFor="git-clone-url">Repository address</Label>
            <Input
              id="git-clone-url"
              autoFocus
              placeholder="https://github.com/owner/repo"
              value={draftUrl}
              onChange={(event) => setDraftUrl(event.target.value)}
            />
            {draftUrl.trim() && !draftClonable && (
              <p className="text-xs text-destructive">Use a github.com/owner/repo address.</p>
            )}
            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!draftClonable || pending}>
                {pending ? (
                  <Spinner className="h-4 w-4 animate-spin" />
                ) : (
                  <CloudDownload className="h-4 w-4" />
                )}
                Clone
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
