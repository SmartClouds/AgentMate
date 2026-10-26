import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LEGACY_PROJECT_DIR,
  NOTIFICATION_HOOK_KINDS,
  type Project,
  RUNOVA_DIR,
} from '@runova/core';
import { installProjectNotificationHooks } from '../notifications/hookInstaller';
import { bridgeScriptSource } from '../runProposals/bridgeScript';
import { moveLegacyRunProposals } from '../runProposals/mcpConfig';

/**
 * Renames a project's `.agentmate` folder to `.runova`. Left alone when the new one exists
 * already, so nothing is ever merged or overwritten. Returns whether it moved.
 */
export async function moveLegacyProjectFolder(folder: string): Promise<boolean> {
  if (folder.trim() === '') return false;
  const legacy = join(folder, LEGACY_PROJECT_DIR);
  const current = join(folder, RUNOVA_DIR);
  if (!existsSync(legacy) || existsSync(current)) return false;
  await rename(legacy, current);
  return true;
}

/**
 * Brings one project's files over from before the rename: the app's folder, the run-commands
 * bridge in `.mcp.json`, and the Claude Code hooks that point into the folder. The hooks are also
 * written again when `refreshHooks` is set, because they name the port file in the app's profile,
 * which moved with the rename. A project whose folder is offline is tried again next start.
 */
export async function moveLegacyProjectFiles(
  project: Project,
  portFile: string,
  refreshHooks: boolean,
): Promise<void> {
  const moved = await moveLegacyProjectFolder(project.folderPath).catch(() => false);
  await moveLegacyRunProposals(
    project.folderPath,
    bridgeScriptSource({ portFile, projectId: project.id }),
  ).catch(() => false);
  const hasHooks = NOTIFICATION_HOOK_KINDS.some((kind) => project.notifications?.[kind]?.enabled);
  if ((moved || refreshHooks) && hasHooks) {
    await installProjectNotificationHooks(project).catch(() => undefined);
  }
}
