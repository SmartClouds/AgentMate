import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import AdmZip from 'adm-zip';
import { app, dialog, ipcMain } from 'electron';
import type {
  BackupExportOptions,
  BackupExportResult,
  BackupImportResult,
  BackupOpenResult,
  BackupRestoreOptions,
  StoredProjectEnvironment,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  BACKUP_VERSION,
  type BackupData,
  type BackupEnvelope,
  parseBackup,
} from '../backup/envelope';
import {
  type EncryptedEnvironmentsSection,
  readEnvironmentsSection,
  sealEnvironments,
  toStoredEnvironments,
  unsealEnvironments,
} from '../backup/environmentsCipher';
import { currentVaultSection, readVaultSection, restoreVaultSection } from '../backup/vaultSection';
import {
  exportAttachments,
  importAttachments,
  referencedAttachmentFiles,
} from '../blueprintFileStore';
import { blueprintRevisionDb } from '../blueprintRevisionDb';
import { petManager } from '../pet/petWindow';
import { promptHistoryDb } from '../promptHistoryDb';
import { skillAuditDb } from '../skillAuditDb';
import { store } from '../store';
import { studioService } from '../studio';
import { electronVaultFiles, getVaultService } from '../vault';
import type { VaultFileV1 } from '../vault/format';

const ZIP_ENTRY_NAME = 'backup.json';

interface PendingRestore {
  token: string;
  data: BackupData;
  warnings: string[];
  environments: EncryptedEnvironmentsSection | null;
  vault: VaultFileV1 | null;
}

/**
 * The backup picked by `backup:open`, held until `backup:restore` confirms it. Keeping it here
 * means the file is read and checked once, and the renderer never gets to name a path to restore.
 */
let pendingRestore: PendingRestore | null = null;

async function readCurrentData(): Promise<Required<BackupData>> {
  const blueprints = await store.getBlueprints();
  return {
    projects: await store.getProjects(),
    settings: await store.getSettings(),
    activity: await store.getActivity(),
    templates: await store.getTemplates(),
    repositories: await store.getRepositories(),
    mcpRepositories: await store.getMcpRepositories(),
    projectDrafts: await store.getProjectDrafts(),
    scheduledTasks: await store.getScheduledTasks(),
    promptHistory: promptHistoryDb.exportAll(),
    skillAudits: skillAuditDb.exportAll(),
    skillFavorites: await store.getFavoriteSkills(),
    appNotifications: await store.getAppNotifications(),
    blueprints,
    blueprintPresets: await store.getBlueprintPresets(),
    blueprintRevisions: blueprintRevisionDb.exportAll(),
    // Blueprint attachments are files rather than inline data, so unlike project
    // icons they have to be read in on purpose to ride along.
    blueprintAttachments: await exportAttachments(referencedAttachmentFiles(blueprints)),
    studio: await studioService().backupData(),
  };
}

/**
 * Persists whatever sections the payload carries. Every section is validated
 * before this runs, so the only way it can fail here is a disk error, which the
 * caller rolls back from with the snapshot it took first.
 */
async function writeData(data: BackupData): Promise<void> {
  if (data.projects) await store.setProjects(data.projects);
  if (data.settings) await store.setSettings(data.settings);
  if (data.activity) await store.setActivity(data.activity);
  if (data.templates) await store.setTemplates(data.templates);
  if (data.repositories) await store.setRepositories(data.repositories);
  if (data.mcpRepositories) await store.setMcpRepositories(data.mcpRepositories);
  if (data.projectDrafts) await store.setProjectDrafts(data.projectDrafts);
  if (data.scheduledTasks) await store.setScheduledTasks(data.scheduledTasks);
  if (data.promptHistory) promptHistoryDb.importAll(data.promptHistory);
  if (data.skillAudits) skillAuditDb.importAll(data.skillAudits);
  if (data.skillFavorites) await store.setFavoriteSkills(data.skillFavorites);
  if (data.appNotifications) await store.setAppNotifications(data.appNotifications);
  // Files first: storing the blueprints collects every attachment nothing points
  // at, which the other way round would delete the ones about to be restored.
  if (data.blueprintAttachments) await importAttachments(data.blueprintAttachments);
  if (data.blueprints) await store.setBlueprints(data.blueprints);
  if (data.blueprintPresets) await store.setBlueprintPresets(data.blueprintPresets);
  if (data.blueprintRevisions) blueprintRevisionDb.importAll(data.blueprintRevisions);
  if (data.studio) await studioService().restoreBackup(data.studio);
}

export function registerBackupHandlers(): void {
  ipcMain.handle(
    IPC.backup.export,
    async (
      _event,
      compress: boolean,
      options: BackupExportOptions = {},
    ): Promise<BackupExportResult> => {
      // Before the save dialog, so a locked vault is reported without a file picked for nothing.
      let environments: EncryptedEnvironmentsSection | undefined;
      if (options.environmentsPassword) {
        try {
          environments = await sealEnvironments(options.environmentsPassword);
        } catch (error) {
          return {
            ok: false,
            error: `Could not include project environments: ${error instanceof Error ? error.message : 'unknown error'}`,
          };
        }
      }

      const dateStamp = new Date().toISOString().slice(0, 10);
      const result = await dialog.showSaveDialog({
        defaultPath: compress
          ? `agentmate-backup-${dateStamp}.zip`
          : `agentmate-backup-${dateStamp}.json`,
        filters: compress
          ? [{ name: 'AgentMate Backup (zip)', extensions: ['zip'] }]
          : [{ name: 'AgentMate Backup', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false };

      const envelope: BackupEnvelope = {
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        appVersion: app.isPackaged ? app.getVersion() : 'dev',
        data: {
          ...(await readCurrentData()),
          projectEnvironments: environments,
          vault:
            options.includeVault === false
              ? undefined
              : ((await currentVaultSection(electronVaultFiles)) ?? undefined),
        },
      };
      const json = JSON.stringify(envelope, null, 2);

      // A full disk or a read-only folder is an ordinary outcome here, and the
      // import handler already answers with { ok, error } rather than rejecting.
      try {
        if (compress) {
          const zip = new AdmZip();
          zip.addFile(ZIP_ENTRY_NAME, Buffer.from(json, 'utf-8'));
          zip.writeZip(result.filePath);
        } else {
          await writeFile(result.filePath, json, 'utf-8');
        }
      } catch (error) {
        return {
          ok: false,
          error: `Could not write that file: ${error instanceof Error ? error.message : 'unknown error'}`,
        };
      }
      return { ok: true, path: result.filePath };
    },
  );

  ipcMain.handle(IPC.backup.open, async (): Promise<BackupOpenResult> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'AgentMate Backup', extensions: ['json', 'zip'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false };

    let parsed: unknown;
    try {
      const filePath = result.filePaths[0];
      const raw =
        extname(filePath).toLowerCase() === '.zip'
          ? new AdmZip(filePath).readAsText(ZIP_ENTRY_NAME)
          : await readFile(filePath, 'utf-8');
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'Could not read that file.' };
    }

    // Validate everything up front. The old code wrote each section as it went,
    // so one malformed row left the user with half their data replaced and half
    // restored, and no error to show for it.
    const backup = parseBackup(parsed);
    if (!backup.ok) return { ok: false, error: backup.error };

    // Studio checks its own section; a damaged one is left out rather than failing the restore.
    if (backup.data.studio) {
      const problem = studioService().checkBackup(backup.data.studio);
      if (problem) {
        delete backup.data.studio;
        backup.warnings.push(`${problem} It was skipped.`);
      }
    }

    const rawData = (parsed as { data: Record<string, unknown> }).data;
    const environments = readEnvironmentsSection(rawData.projectEnvironments);
    const warnings = [...backup.warnings];
    if (rawData.projectEnvironments !== undefined && !environments) {
      warnings.push('The project environments in this backup could not be read and were skipped.');
    }

    const vault = readVaultSection(rawData.vault);
    if (rawData.vault !== undefined && !vault) {
      warnings.push('The Vault in this backup could not be read and was skipped.');
    }

    pendingRestore = { token: randomUUID(), data: backup.data, warnings, environments, vault };
    return {
      ok: true,
      token: pendingRestore.token,
      environments: environments ? { count: environments.count } : undefined,
      vault: vault ? { present: true } : undefined,
    };
  });

  ipcMain.handle(
    IPC.backup.restore,
    async (_event, token: string, options: BackupRestoreOptions): Promise<BackupImportResult> => {
      const pending = pendingRestore;
      if (!pending || pending.token !== token) {
        return { ok: false, error: 'Choose the backup file again.' };
      }
      const warnings = [...pending.warnings];

      // Everything that can fail on the environments happens before anything is written:
      // a wrong password, or a locked vault that can't encrypt them for this computer.
      let environments: StoredProjectEnvironment[] | null = null;
      if (pending.environments && options.environmentsPassword) {
        const rows = await unsealEnvironments(pending.environments, options.environmentsPassword);
        if (!rows) return { ok: false, wrongPassword: true };
        const projectIds = new Set(
          (pending.data.projects ?? (await store.getProjects())).map((project) => project.id),
        );
        try {
          const built = await toStoredEnvironments(rows, projectIds);
          environments = built.environments;
          if (built.skipped > 0) {
            warnings.push(`Skipped ${built.skipped} unreadable project environment entries.`);
          }
        } catch (error) {
          return {
            ok: false,
            error: `Could not restore project environments: ${error instanceof Error ? error.message : 'unknown error'}. Nothing was changed.`,
          };
        }
      }

      const snapshot = await readCurrentData();
      const environmentsSnapshot = await store.getProjectEnvironments();
      try {
        await writeData(pending.data);
        if (environments) await store.setProjectEnvironments(environments);
      } catch (error) {
        // Put back what was there before rather than leaving a half-written store.
        await writeData(snapshot).catch(() => undefined);
        await store.setProjectEnvironments(environmentsSnapshot).catch(() => undefined);
        return {
          ok: false,
          error: `Could not restore that backup: ${error instanceof Error ? error.message : 'unknown error'}. Your existing data was left in place.`,
        };
      }

      // Last, and on its own: everything else is already in place, and a vault that fails to
      // restore leaves this computer's vault where it was.
      if (pending.vault && options.restoreVault) {
        try {
          await restoreVaultSection(
            pending.vault,
            electronVaultFiles,
            () => getVaultService().lock('restore'),
            new Date(),
          );
        } catch (error) {
          warnings.push(
            `The Vault could not be restored: ${error instanceof Error ? error.message : 'unknown error'}. Your existing Vault was kept.`,
          );
        }
      }

      pendingRestore = null;
      void petManager.syncFromSettings();
      return { ok: true, warnings };
    },
  );
}
