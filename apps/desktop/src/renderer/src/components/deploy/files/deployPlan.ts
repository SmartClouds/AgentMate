import type {
  FileSite,
  FileSiteConnectionInput,
  FileSiteInput,
  FilesDeployInput,
  FilesPendingFile,
  FilesPlanChange,
} from '@shared/deployFilesTypes';
import type { FilesReview } from '@/stores/deployFilesRunStore';

/**
 * From a review to the deploy call (E23). Only the plan's paths that are ticked go, every
 * conflict among them carries a choice, and the review is skipped when nothing in it needs one.
 */

/** The paths that go: the ticked pending files, or only the failed ones a retry is about. */
export function allowedPaths(
  review: FilesReview,
  files: readonly FilesPendingFile[],
  deselected: ReadonlySet<string>,
): Set<string> {
  if (review.only) return new Set(review.only);
  return new Set(files.filter((file) => !deselected.has(file.path)).map((file) => file.path));
}

/** How many ticked files there are, and the bytes they send (a delete sends none). */
export function selectedTotals(
  files: readonly FilesPendingFile[],
  deselected: ReadonlySet<string>,
): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const file of files) {
    if (deselected.has(file.path)) continue;
    count += 1;
    if (file.change !== 'deleted') bytes += file.size;
  }
  return { count, bytes };
}

export function reviewConflicts(
  review: FilesReview,
  allowed: ReadonlySet<string>,
): FilesPlanChange[] {
  return review.plan.changes.filter(
    (change) => change.action === 'conflict' && allowed.has(change.path),
  );
}

/** The files this deploy deletes on the server, for the confirmation. */
export function deletesIn(review: FilesReview, allowed: ReadonlySet<string>): string[] {
  return review.plan.changes
    .filter(
      (change) =>
        allowed.has(change.path) &&
        (change.action === 'deleteRemote' ||
          (change.action === 'conflict' &&
            change.local === 'deleted' &&
            review.conflicts[change.path] === 'overwrite')),
    )
    .map((change) => change.path);
}

/** Whether the review has to be shown, or the deploy can go straight on. */
export function needsReview(review: FilesReview, allowed: ReadonlySet<string>): boolean {
  const { plan } = review;
  return (
    reviewConflicts(review, allowed).length > 0 ||
    plan.firstDeploy !== null ||
    plan.massDelete ||
    plan.missingOnServer.length > 0 ||
    plan.clockShiftHours !== null ||
    plan.notices.includes('clockShift')
  );
}

export function canContinue(review: FilesReview, allowed: ReadonlySet<string>): boolean {
  if (review.plan.firstDeploy && !review.firstDeploy) return false;
  return reviewConflicts(review, allowed).every((change) => review.conflicts[change.path]);
}

export function buildDeployInput(
  review: FilesReview,
  allowed: ReadonlySet<string>,
): FilesDeployInput {
  const { plan } = review;
  const going = plan.changes.filter((change) => allowed.has(change.path));
  const conflicts: FilesDeployInput['conflicts'] = {};
  for (const change of going) {
    const choice = review.conflicts[change.path];
    if (change.action === 'conflict' && choice) conflicts[change.path] = choice;
  }
  const missing = new Set(plan.missingOnServer);
  return {
    siteId: plan.siteId,
    planId: plan.planId,
    paths: going.map((change) => change.path),
    conflicts,
    firstDeploy: plan.firstDeploy ? review.firstDeploy : null,
    reupload: review.reupload.filter((path) => missing.has(path)),
  };
}

/**
 * A saved site as the input `update` takes, with changes on top. The connection is rebuilt field
 * by field: `hasSecret` is not part of the input, and no secret is ever sent, so the stored one
 * stays.
 */
export function siteInputFrom(site: FileSite, changes: Partial<FileSiteInput> = {}): FileSiteInput {
  const { connection } = site;
  const input: FileSiteConnectionInput =
    connection.kind === 'saved'
      ? { kind: 'saved', sshServerId: connection.sshServerId }
      : {
          kind: 'custom',
          host: connection.host,
          port: connection.port,
          username: connection.username,
          authMethod: connection.authMethod,
          privateKeyPath: connection.privateKeyPath,
          hostKeyFingerprint: connection.hostKeyFingerprint,
          tlsPin: connection.tlsPin,
          tlsServername: connection.tlsServername,
        };
  return {
    label: site.label,
    protocol: site.protocol,
    connection: input,
    remoteRoot: site.remoteRoot,
    localFolder: site.localFolder,
    projectIds: [...site.projectIds],
    deployOnSave: site.deployOnSave,
    quietSeconds: site.quietSeconds,
    ignorePatterns: [...site.ignorePatterns],
    ...changes,
  };
}
