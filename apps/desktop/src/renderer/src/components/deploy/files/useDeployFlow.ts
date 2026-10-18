import { filesErrorCode } from '@shared/deployFilesErrors';
import type { FileSite, FilesConflictChoice, FilesPendingFile } from '@shared/deployFilesTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { confirmDialog } from '@/stores/confirmStore';
import {
  type FilesProblem,
  type FilesSiteRun,
  isRunActive,
  selectSiteRun,
  useDeployFilesRunStore,
} from '@/stores/deployFilesRunStore';
import { plural } from './copy';
import { allowedPaths, buildDeployInput, canContinue, deletesIn, needsReview } from './deployPlan';
import { finishRun } from './hooks';
import { withFileSiteHostKeyTrust } from './hostKey';
import { filesProblem } from './messages';

/**
 * One site's deploy, from the button to the outcome (E23): check the server, show the review when
 * something in it needs a choice (or go straight on when nothing does), confirm any deletes, send,
 * and take the outcome. The state lives in the run store, so it survives leaving the page, and
 * the Deploy page and a project's Deploy tab drive the same flow.
 */

/** Deletes listed by name in the confirmation; the rest are counted. */
const CONFIRM_LIST = 8;

function problemOf(error: unknown): FilesProblem {
  return { message: filesProblem(error), code: filesErrorCode(error) };
}

export interface DeployFlow {
  run: FilesSiteRun;
  /** The paths that go: ticked files, or the failed ones being retried. */
  allowed: Set<string>;
  /** Checks the server; with `only`, a retry limited to those paths. */
  start: (only?: string[] | null) => Promise<void>;
  /** Sends the reviewed plan. */
  proceed: () => Promise<void>;
  back: () => void;
  cancel: () => Promise<void>;
  cancelling: boolean;
  dismiss: () => void;
  chooseConflicts: (choices: Record<string, FilesConflictChoice>) => void;
  chooseFirstDeploy: (choice: 'adoptSameSize' | 'overwrite') => void;
  setReupload: (paths: string[]) => void;
}

export function useDeployFlow({
  site,
  files,
}: {
  site: FileSite;
  files: readonly FilesPendingFile[];
}): DeployFlow {
  const siteId = site.id;
  const queryClient = useQueryClient();
  const run = useDeployFilesRunStore(selectSiteRun(siteId));
  const [cancelling, setCancelling] = useState(false);
  // The site changes after a host key is trusted, and the files with every snapshot.
  const latest = useRef({ files, site });
  latest.current = { files, site };

  const active = isRunActive(run);
  useEffect(() => {
    if (!active) setCancelling(false);
  }, [active]);

  const reviewNow = useCallback(
    () => useDeployFilesRunStore.getState().runs[siteId]?.review ?? null,
    [siteId],
  );
  // The unticked files live in the store, so a check started before a remount sees them too.
  const allowedFor = useCallback(
    (review: NonNullable<FilesSiteRun['review']>) =>
      allowedPaths(
        review,
        latest.current.files,
        useDeployFilesRunStore.getState().runs[siteId]?.deselected ?? new Set(),
      ),
    [siteId],
  );
  /** Runs a call on the server, asking about a changed SFTP host key the way Remote does. */
  const onServer = useCallback(
    <T>(attempt: () => Promise<T>): Promise<T> =>
      withFileSiteHostKeyTrust(latest.current.site, attempt),
    [],
  );

  const send = useCallback(
    async (straight: boolean): Promise<void> => {
      let review = reviewNow();
      if (!review) return;
      let allowed = allowedFor(review);
      if (!canContinue(review, allowed)) return;
      const deletes = deletesIn(review, allowed);
      if (deletes.length > 0) {
        const confirmed = await confirmDialog({
          title: `Delete ${plural(deletes.length, 'file')} from the server?`,
          description:
            "They were deleted in the deploy folder. Each one was sent by an earlier deploy and hasn't changed on the server since.",
          items: deletes.slice(0, CONFIRM_LIST).map((path) => ({ name: path })),
          moreCount: Math.max(0, deletes.length - CONFIRM_LIST),
          confirmLabel: 'Delete and deploy',
          variant: 'destructive',
        });
        // The review stays up, so the deletes can be unticked.
        if (!confirmed) return;
        // While the question was up, a Deploy on save run may have taken the review away, or the
        // folder changed what goes: only send what was confirmed, from the review still open.
        const now = reviewNow();
        if (!now || now !== review) return;
        review = now;
        allowed = allowedFor(review);
        const confirmedDeletes = new Set(deletes);
        if (
          !canContinue(review, allowed) ||
          deletesIn(review, allowed).some((path) => !confirmedDeletes.has(path))
        ) {
          return;
        }
      }
      const input = buildDeployInput(review, allowed);
      const store = useDeployFilesRunStore.getState();
      if (input.paths.length === 0 && input.reupload.length === 0) {
        store.clearReview(siteId);
        store.setProblem(siteId, {
          message: 'Nothing left to send: the server already has what is ticked.',
          code: null,
        });
        return;
      }
      store.begin(
        siteId,
        straight
          ? {
              notices: review.plan.notices.filter((notice) => notice !== 'clockShift'),
              drift: review.plan.serverOnlyDrift,
            }
          : null,
      );
      try {
        const result = await onServer(() => window.agentmat.deployFiles.deploy(input));
        if (result) finishRun(queryClient, result);
      } catch (error) {
        useDeployFilesRunStore.getState().failStart(siteId, problemOf(error));
      }
    },
    [siteId, queryClient, reviewNow, allowedFor, onServer],
  );

  const start = useCallback(
    async (only: string[] | null = null): Promise<void> => {
      const store = useDeployFilesRunStore.getState();
      store.dismissResult(siteId);
      store.setPlanning(siteId, true);
      // A Deploy on save run that started while the server was asked (or a Back) makes the
      // answer stale: it must neither bring a review back nor start a deploy over that run.
      const stillWanted = (): boolean => {
        const now = useDeployFilesRunStore.getState().runs[siteId];
        return Boolean(now?.planning) && !(now && isRunActive(now));
      };
      try {
        const plan = await onServer(() => window.agentmat.deployFiles.plan({ siteId }));
        if (!plan) throw new Error('The server check sent nothing back.');
        if (!stillWanted()) return;
        useDeployFilesRunStore.getState().setReview(siteId, plan, only);
      } catch (error) {
        if (stillWanted()) useDeployFilesRunStore.getState().setProblem(siteId, problemOf(error));
        return;
      }
      const review = reviewNow();
      if (review && !needsReview(review, allowedFor(review))) await send(true);
    },
    [siteId, reviewNow, allowedFor, send, onServer],
  );

  const cancel = useCallback(async (): Promise<void> => {
    setCancelling(true);
    try {
      await window.agentmat.deployFiles.cancel(siteId);
    } catch (error) {
      setCancelling(false);
      toast.error(filesProblem(error));
    }
  }, [siteId]);

  const store = useDeployFilesRunStore.getState();
  return {
    run,
    allowed: run.review ? allowedPaths(run.review, files, run.deselected) : new Set(),
    start,
    proceed: () => send(false),
    back: () => store.clearReview(siteId),
    cancel,
    cancelling,
    dismiss: () => store.dismissResult(siteId),
    chooseConflicts: (choices) => store.chooseConflicts(siteId, choices),
    chooseFirstDeploy: (choice) => store.chooseFirstDeploy(siteId, choice),
    setReupload: (paths) => store.setReupload(siteId, paths),
  };
}
