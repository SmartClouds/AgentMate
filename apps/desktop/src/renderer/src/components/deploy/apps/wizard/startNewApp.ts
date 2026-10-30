import type { Project } from '@runova/core';
import { folderName, suggestAppName } from '@/lib/deploy/apps/format';
import {
  emptyDraft,
  isAppRunBusy,
  useDeployAppRunStore,
  wizardKey,
} from '@/stores/deployAppRunStore';

/** Opens a wizard afresh, unless a deploy from it is still on its way or waiting. */
export function freshWizard(serverId: string, existingStackId: string | null): void {
  const key = wizardKey(serverId, existingStackId);
  const kept = useDeployAppRunStore.getState().wizards[key];
  if (kept && (isAppRunBusy(kept.run) || kept.run.phase === 'confirm')) return;
  useDeployAppRunStore.getState().reset(key);
}

/**
 * Readies a server's New App wizard with a project already picked, for a deploy started from
 * the project's own page. A deploy still on its way keeps the wizard; it shows that deploy.
 */
export function startNewAppFor(
  serverId: string,
  project: Pick<Project, 'id' | 'name' | 'folderPath'>,
): void {
  freshWizard(serverId, null);
  const draft = emptyDraft();
  useDeployAppRunStore.getState().open(
    wizardKey(serverId, null),
    emptyDraft({
      source: {
        ...draft.source,
        projectId: project.id,
        projectName: project.name,
        projectFolder: project.folderPath,
        name: suggestAppName(project.name || folderName(project.folderPath)),
      },
    }),
  );
}
