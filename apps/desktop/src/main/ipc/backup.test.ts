import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '@agentmat/core';
import AdmZip from 'adm-zip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BackupExportResult,
  BackupImportResult,
  BackupOpenResult,
  StoredProjectEnvironment,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { queueDialog } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import {
  electronState,
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';
import { BACKUP_VERSION, type BackupEnvelope } from '../backup/envelope';
import { encryptSecret } from '../ssh/vault';
import { store } from '../store';

/**
 * Export and restore, through the real envelope and the real cipher. The only thing stubbed is
 * the save/open dialog, which is what decides the path: the renderer never names one, so a test
 * has to answer the dialog the way the user would.
 *
 * The three SQLite-backed stores are stood in for in memory. They each keep one open database
 * handle for the lifetime of the process, and the handle would still point at the previous test's
 * userData folder, which Windows then refuses to delete. Their own SQL is covered by
 * promptHistoryDb's tests; what matters here is that whatever they hand over rides along in the
 * envelope and comes back on restore.
 */

const dbRows = vi.hoisted(() => ({
  promptHistory: [] as unknown[],
  skillAudits: [] as unknown[],
  blueprintRevisions: [] as unknown[],
}));

vi.mock('../promptHistoryDb', () => ({
  promptHistoryDb: {
    exportAll: () => dbRows.promptHistory,
    importAll: (rows: unknown[]) => {
      dbRows.promptHistory = rows;
    },
  },
}));
vi.mock('../skillAuditDb', () => ({
  skillAuditDb: {
    exportAll: () => dbRows.skillAudits,
    importAll: (rows: unknown[]) => {
      dbRows.skillAudits = rows;
    },
  },
}));
vi.mock('../blueprintRevisionDb', () => ({
  blueprintRevisionDb: {
    exportAll: () => dbRows.blueprintRevisions,
    importAll: (rows: unknown[]) => {
      dbRows.blueprintRevisions = rows;
    },
    removeForProject: () => undefined,
  },
}));

const userData = useTempUserData();
const out = { dir: '' };
const PASSWORD = 'backup password 123';
const PROJECT_ID = 'project-1';

expectChannelsCovered(IPC.backup);

function seedProject(name = 'Demo'): Project {
  const project = {
    id: PROJECT_ID,
    name,
    folderPath: join(out.dir, 'demo'),
    description: '',
    tags: [],
    agentType: 'claude-code',
    notes: '',
    runCommands: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Project;
  userData.writeData('projects.json', [project]);
  return project;
}

/** Exports to `fileName` inside the throwaway output folder and returns where it landed. */
async function exportTo(
  fileName: string,
  options: { environmentsPassword?: string; includeVault?: boolean } = {},
  compress = false,
): Promise<{ result: BackupExportResult; path: string }> {
  const path = join(out.dir, fileName);
  queueDialog('showSaveDialog', { canceled: false, filePath: path });
  const result = await invoke<BackupExportResult>(IPC.backup.export, compress, options);
  return { result, path };
}

function readEnvelope(path: string): BackupEnvelope {
  return JSON.parse(readFileSync(path, 'utf-8')) as BackupEnvelope;
}

/** Answers the open dialog with `path` and hands back the restore token. */
async function open(path: string): Promise<BackupOpenResult> {
  queueDialog('showOpenDialog', { canceled: false, filePaths: [path] });
  return invoke<BackupOpenResult>(IPC.backup.open);
}

beforeEach(async () => {
  out.dir = tempDir('agentmate-backup-out-');
  dbRows.promptHistory = [];
  dbRows.skillAudits = [];
  dbRows.blueprintRevisions = [];
  await loadIpc(
    () => import('./backup'),
    (module) => module.registerBackupHandlers(),
  );
});

describe('backup:export', () => {
  it('writes an envelope with the current data to the path the dialog returned', async () => {
    seedProject();
    userData.writeData('templates.json', [
      { id: 't1', name: 'Review', content: 'review this', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);

    const { result, path } = await exportTo('backup.json');
    expect(result).toEqual({ ok: true, path });

    const envelope = readEnvelope(path);
    expect(envelope.version).toBe(BACKUP_VERSION);
    expect(Date.parse(envelope.exportedAt)).not.toBeNaN();
    // Not packaged in a test run, so the version is reported as a dev build.
    expect(envelope.appVersion).toBe('dev');
    expect(envelope.data.projects?.map((project) => project.id)).toEqual([PROJECT_ID]);
    expect(envelope.data.templates?.map((template) => template.id)).toEqual(['t1']);
    // No password was given, so the environments section stays off this computer.
    expect(envelope.data.projectEnvironments).toBeUndefined();
  });

  it('suggests a dated file name, and the zip filter when compressing', async () => {
    seedProject();
    queueDialog('showSaveDialog', { canceled: true, filePath: undefined });
    await invoke(IPC.backup.export, false, {});
    expect(electronState.dialogCalls.at(-1)?.args[0]).toMatchObject({
      defaultPath: expect.stringMatching(/^agentmate-backup-\d{4}-\d{2}-\d{2}\.json$/),
    });

    queueDialog('showSaveDialog', { canceled: true, filePath: undefined });
    await invoke(IPC.backup.export, true, {});
    expect(electronState.dialogCalls.at(-1)?.args[0]).toMatchObject({
      defaultPath: expect.stringMatching(/\.zip$/),
    });
  });

  it('puts the same envelope inside a zip when asked to compress', async () => {
    seedProject('Zipped');
    const { result, path } = await exportTo('backup.zip', {}, true);
    expect(result.ok).toBe(true);

    const entry = new AdmZip(path).readAsText('backup.json');
    const envelope = JSON.parse(entry) as BackupEnvelope;
    expect(envelope.data.projects?.[0].name).toBe('Zipped');
  });

  it('reports a cancelled dialog without writing anything', async () => {
    seedProject();
    queueDialog('showSaveDialog', { canceled: true, filePath: undefined });
    expect(await invoke<BackupExportResult>(IPC.backup.export, false, {})).toEqual({ ok: false });
    expect(existsSync(join(out.dir, 'backup.json'))).toBe(false);
  });

  it('turns a failed write into an error instead of rejecting', async () => {
    seedProject();
    // A folder rather than a file: writeFile fails the way a full disk or a read-only
    // folder would, and the renderer expects { ok: false, error } for that.
    const { result } = await exportTo('.');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not write that file');
  });
});

describe('backup:open and backup:restore', () => {
  it('restores the exported data over what is there now', async () => {
    seedProject('Before export');
    const { path } = await exportTo('roundtrip.json');

    // Whatever the user did between the export and the restore.
    userData.writeData('projects.json', [
      { id: 'other', name: 'Added later', folderPath: out.dir, createdAt: '2026-02-01T00:00:00Z' },
    ]);

    const opened = await open(path);
    expect(opened.ok).toBe(true);
    expect(opened.token).toBeTruthy();

    const restored = await invoke<BackupImportResult>(IPC.backup.restore, opened.token, {
      environmentsPassword: null,
    });
    expect(restored.ok).toBe(true);
    const projects = await store.getProjects();
    expect(projects.map((project) => project.name)).toEqual(['Before export']);
  });

  it('carries the prompt history along and puts it back on restore', async () => {
    seedProject();
    dbRows.promptHistory = [
      {
        id: 'ph-1',
        rawInput: 'make it faster',
        promptType: 'feature',
        targetAI: 'claude-code',
        content: 'Make it faster, please.',
        source: 'builder',
        tags: [],
        projectId: PROJECT_ID,
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ];
    const { path } = await exportTo('history.json');
    expect(readEnvelope(path).data.promptHistory).toHaveLength(1);

    dbRows.promptHistory = [];
    const opened = await open(path);
    await invoke(IPC.backup.restore, opened.token, { environmentsPassword: null });
    expect(dbRows.promptHistory).toHaveLength(1);
  });

  it("carries Studio's settings and recipes, and skips a damaged Studio section (E39)", async () => {
    seedProject();
    const { studioService } = await import('../studio');
    await studioService().updateSettings({ cacheCapGb: 33 });
    await studioService().saveRecipe({
      name: 'Explainer',
      brief: 'Explain it',
      styleId: null,
      language: 'en',
      aspect: '16:9',
      targetSeconds: 30,
      scenario: { cliId: null },
    });
    const { path } = await exportTo('studio.json');
    const envelope = readEnvelope(path);
    expect(envelope.data.studio).toMatchObject({ settings: { cacheCapGb: 33 } });

    await studioService().updateSettings({ cacheCapGb: 5 });
    for (const recipe of await studioService().recipes()) {
      await studioService().deleteRecipe({ recipeId: recipe.id });
    }
    const opened = await open(path);
    await invoke(IPC.backup.restore, opened.token, { environmentsPassword: null });
    expect((await studioService().settings()).cacheCapGb).toBe(33);
    expect((await studioService().recipes()).map((r) => r.name)).toEqual(['Explainer']);

    const damaged = { ...envelope, data: { ...envelope.data, studio: { recipes: 'nope' } } };
    writeFileSync(path, JSON.stringify(damaged));
    const again = await open(path);
    const restored = await invoke<BackupImportResult>(IPC.backup.restore, again.token, {
      environmentsPassword: null,
    });
    expect(restored.ok).toBe(true);
    expect(JSON.stringify(restored)).toContain(
      "The backup's Studio recipes could not be read. It was skipped.",
    );
    expect((await studioService().recipes()).map((r) => r.name)).toEqual(['Explainer']);
    const { shutdownStudio } = await import('../studio');
    await shutdownStudio();
  });

  it('spends the token, so a second restore has to pick the file again', async () => {
    seedProject();
    const { path } = await exportTo('once.json');
    const opened = await open(path);
    await invoke(IPC.backup.restore, opened.token, { environmentsPassword: null });

    expect(
      await invoke<BackupImportResult>(IPC.backup.restore, opened.token, {
        environmentsPassword: null,
      }),
    ).toEqual({ ok: false, error: 'Choose the backup file again.' });
  });

  it('refuses a token it never issued', async () => {
    expect(
      await invoke<BackupImportResult>(IPC.backup.restore, 'made-up-token', {
        environmentsPassword: null,
      }),
    ).toEqual({ ok: false, error: 'Choose the backup file again.' });
  });

  it('changes nothing when the open dialog is cancelled', async () => {
    seedProject('Untouched');
    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
    expect(await invoke<BackupOpenResult>(IPC.backup.open)).toEqual({ ok: false });
    expect((await store.getProjects())[0].name).toBe('Untouched');
  });

  it('reports a file it cannot read, and one that is not a backup', async () => {
    const notJson = join(out.dir, 'notes.json');
    writeFileSync(notJson, 'this is not json at all', 'utf-8');
    expect(await open(notJson)).toEqual({ ok: false, error: 'Could not read that file.' });

    const wrongShape = join(out.dir, 'other.json');
    writeFileSync(wrongShape, JSON.stringify({ hello: 'world' }), 'utf-8');
    const opened = await open(wrongShape);
    expect(opened.ok).toBe(false);
    expect(opened.error).toBeTruthy();
  });

  it('reads a zipped backup back in', async () => {
    seedProject('From zip');
    const { path } = await exportTo('restore.zip', {}, true);
    userData.writeData('projects.json', []);

    const opened = await open(path);
    const restored = await invoke<BackupImportResult>(IPC.backup.restore, opened.token, {
      environmentsPassword: null,
    });
    expect(restored.ok).toBe(true);
    expect((await store.getProjects())[0].name).toBe('From zip');
  });

  it('warns about a section it could not read rather than refusing the whole backup', async () => {
    seedProject();
    const { path } = await exportTo('damaged.json');
    // Deliberately not a section either reader can accept, so the types have to be dropped.
    const envelope = JSON.parse(readFileSync(path, 'utf-8')) as {
      data: Record<string, unknown>;
    };
    envelope.data.projectEnvironments = { kdf: 'not-scrypt' };
    envelope.data.vault = { nope: true };
    writeFileSync(path, JSON.stringify(envelope), 'utf-8');

    const opened = await open(path);
    expect(opened.ok).toBe(true);
    expect(opened.environments).toBeUndefined();
    expect(opened.vault).toBeUndefined();

    const restored = await invoke<BackupImportResult>(IPC.backup.restore, opened.token, {
      environmentsPassword: null,
    });
    expect(restored.ok).toBe(true);
    expect(restored.warnings).toEqual(
      expect.arrayContaining([
        'The project environments in this backup could not be read and were skipped.',
        'The Vault in this backup could not be read and was skipped.',
      ]),
    );
  });
});

describe('backup environments section', () => {
  /** One stored environment, encrypted for this computer the way the app stores it. */
  async function seedEnvironment(): Promise<void> {
    const environment: StoredProjectEnvironment = {
      id: 'env-1',
      projectId: PROJECT_ID,
      name: 'Production',
      kind: 'production',
      order: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      files: [
        {
          id: 'file-1',
          fileName: '.env.production',
          keyCount: 1,
          contentEnvelope: await encryptSecret('API_TOKEN=super-secret\n'),
          updatedAt: 1_700_000_000_000,
        },
      ],
      credentials: [
        {
          id: 'cred-1',
          label: 'Database',
          username: 'app',
          url: 'postgres://db.test',
          secretEnvelope: await encryptSecret('db-password'),
          updatedAt: 1_700_000_000_000,
        },
      ],
    };
    await store.setProjectEnvironments([environment]);
  }

  it('seals the environments under the export password, and restores them with it', async () => {
    seedProject();
    await seedEnvironment();

    const { result, path } = await exportTo('with-env.json', { environmentsPassword: PASSWORD });
    expect(result.ok).toBe(true);
    expect(readEnvelope(path).data.projectEnvironments?.count).toBe(1);
    // The secrets must not be readable in the file itself.
    expect(readFileSync(path, 'utf-8')).not.toContain('super-secret');
    expect(readFileSync(path, 'utf-8')).not.toContain('db-password');

    await store.setProjectEnvironments([]);
    const opened = await open(path);
    expect(opened.environments).toEqual({ count: 1 });

    const restored = await invoke<BackupImportResult>(IPC.backup.restore, opened.token, {
      environmentsPassword: PASSWORD,
    });
    expect(restored.ok).toBe(true);
    const environments = await store.getProjectEnvironments();
    expect(environments).toHaveLength(1);
    expect(environments[0].files[0].fileName).toBe('.env.production');
    expect(environments[0].credentials[0].label).toBe('Database');
  });

  it('fails cleanly on the wrong password, writing nothing, and takes the right one after', async () => {
    seedProject('Before restore');
    await seedEnvironment();
    const { path } = await exportTo('wrong-pass.json', { environmentsPassword: PASSWORD });

    await store.setProjectEnvironments([]);
    userData.writeData('projects.json', [
      { id: 'other', name: 'Still here', folderPath: out.dir, createdAt: '2026-02-01T00:00:00Z' },
    ]);

    const opened = await open(path);
    expect(
      await invoke<BackupImportResult>(IPC.backup.restore, opened.token, {
        environmentsPassword: 'not the password',
      }),
    ).toEqual({ ok: false, wrongPassword: true });
    // Nothing at all was written: the projects are still the ones from before the restore.
    expect((await store.getProjects())[0].name).toBe('Still here');
    expect(await store.getProjectEnvironments()).toEqual([]);

    // The same token still works, so the user just retypes the password.
    const retried = await invoke<BackupImportResult>(IPC.backup.restore, opened.token, {
      environmentsPassword: PASSWORD,
    });
    expect(retried.ok).toBe(true);
    expect((await store.getProjects())[0].name).toBe('Before restore');
    expect(await store.getProjectEnvironments()).toHaveLength(1);
  });

  it('leaves the environments out when the restore gives no password', async () => {
    seedProject();
    await seedEnvironment();
    const { path } = await exportTo('skip-env.json', { environmentsPassword: PASSWORD });

    await store.setProjectEnvironments([]);
    const opened = await open(path);
    const restored = await invoke<BackupImportResult>(IPC.backup.restore, opened.token, {
      environmentsPassword: null,
    });
    expect(restored.ok).toBe(true);
    expect(await store.getProjectEnvironments()).toEqual([]);
  });
});
