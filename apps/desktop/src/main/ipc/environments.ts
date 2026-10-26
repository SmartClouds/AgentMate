import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  countDotenvKeys,
  type DotenvEntry,
  ENVIRONMENT_KINDS,
  type EnvironmentKind,
  guessEnvironmentKind,
  isEnvFileName,
  isEnvTemplateFileName,
  MAX_ENV_FILE_BYTES,
  type Project,
  parseDotenv,
} from '@runova/core';
import { clipboard, ipcMain } from 'electron';
import type {
  EnvCredentialSecrets,
  EnvFolderFile,
  EnvImportPick,
  EnvImportResult,
  EnvWriteResult,
  ProjectEnvironment,
  SaveEnvCredentialInput,
  SaveEnvFileInput,
  SaveEnvironmentInput,
  SecretEnvelope,
  StoredEnvCredential,
  StoredEnvFile,
  StoredProjectEnvironment,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { gitOrNull, isGitRepo } from '../git/plumbing';
import { pruneOrphanHealthTargets } from '../health/store';
import { decryptSecret, encryptSecret } from '../ssh/vault';
import { store } from '../store';

const MAX_NAME_LENGTH = 60;

export function toPublicEnvironment(environment: StoredProjectEnvironment): ProjectEnvironment {
  return {
    ...environment,
    files: environment.files.map(({ contentEnvelope: _content, ...file }) => file),
    credentials: environment.credentials.map(
      ({ secretEnvelope, notesEnvelope, ...credential }) => ({
        ...credential,
        hasSecret: secretEnvelope != null,
        hasNotes: notesEnvelope != null,
      }),
    ),
  };
}

/**
 * Every change reads the whole list, edits it and writes it back, so two quick saves from the
 * renderer would otherwise race and one would be lost. Running them one after another avoids that.
 */
let updateQueue: Promise<unknown> = Promise.resolve();

function mutate<T>(
  change: (environments: StoredProjectEnvironment[]) => Promise<T> | T,
): Promise<T> {
  const next = updateQueue.then(async () => {
    const environments = await store.getProjectEnvironments();
    const result = await change(environments);
    await store.setProjectEnvironments(environments);
    return result;
  });
  updateQueue = next.catch(() => undefined);
  return next;
}

/** An environment's files read back in plain text, for the main process only. */
export interface ResolvedEnvFile {
  fileName: string;
  entries: DotenvEntry[];
}

export interface ResolvedProjectEnvironment {
  id: string;
  name: string;
  /** In the order they are kept, which is the order they apply in. */
  files: ResolvedEnvFile[];
  /** Every key once, the last file that sets it winning, in first-seen order. */
  entries: Array<Pick<DotenvEntry, 'key' | 'value'>>;
}

/**
 * The decrypted entries of one of a project's environments. Only main-process callers (the
 * Apps deploy) use it; nothing here is ever sent to the renderer. It waits for saves already
 * queued, so it reads what the Environments tab shows once they land.
 */
export async function resolveProjectEnvironment(
  projectId: string,
  environmentId: string,
): Promise<ResolvedProjectEnvironment> {
  await updateQueue;
  const environment = findEnvironment(await store.getProjectEnvironments(), environmentId);
  if (environment.projectId !== projectId) {
    throw new Error('That environment belongs to another project.');
  }
  const files: ResolvedEnvFile[] = [];
  const merged = new Map<string, string>();
  for (const file of environment.files) {
    const entries = parseDotenv(await decryptSecret(file.contentEnvelope));
    files.push({ fileName: file.fileName, entries });
    for (const { key, value } of entries) merged.set(key, value);
  }
  return {
    id: environment.id,
    name: environment.name,
    files,
    entries: [...merged].map(([key, value]) => ({ key, value })),
  };
}

function findEnvironment(
  environments: StoredProjectEnvironment[],
  id: string,
): StoredProjectEnvironment {
  const environment = environments.find((e) => e.id === id);
  if (!environment) throw new Error('That environment no longer exists.');
  return environment;
}

async function readEnvironment(id: string): Promise<StoredProjectEnvironment> {
  return findEnvironment(await store.getProjectEnvironments(), id);
}

function findFile(environment: StoredProjectEnvironment, fileId: string): StoredEnvFile {
  const file = environment.files.find((f) => f.id === fileId);
  if (!file) throw new Error('That env file no longer exists.');
  return file;
}

function findCredential(
  environment: StoredProjectEnvironment,
  credentialId: string,
): StoredEnvCredential {
  const credential = environment.credentials.find((c) => c.id === credentialId);
  if (!credential) throw new Error('That credential no longer exists.');
  return credential;
}

async function requireProject(projectId: string): Promise<Project> {
  const project = (await store.getProjects()).find((p) => p.id === projectId);
  if (!project) throw new Error('That project no longer exists.');
  return project;
}

function cleanName(name: string): string {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('Give the environment a name.');
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

function cleanKind(kind: string): EnvironmentKind {
  return (ENVIRONMENT_KINDS as readonly string[]).includes(kind)
    ? (kind as EnvironmentKind)
    : 'custom';
}

function assertFileName(fileName: string): void {
  if (!isEnvFileName(fileName)) {
    throw new Error('Use a file name like .env or .env.production, without folders.');
  }
}

function assertContentSize(content: string): void {
  if (Buffer.byteLength(content, 'utf-8') > MAX_ENV_FILE_BYTES) {
    throw new Error('That file is larger than 1 MB.');
  }
}

function newEnvironment(
  environments: StoredProjectEnvironment[],
  projectId: string,
  name: string,
  kind: EnvironmentKind,
): StoredProjectEnvironment {
  const siblings = environments.filter((e) => e.projectId === projectId);
  const now = Date.now();
  const environment: StoredProjectEnvironment = {
    id: randomUUID(),
    projectId,
    name: cleanName(name),
    kind: cleanKind(kind),
    order: siblings.reduce((max, e) => Math.max(max, e.order + 1), 0),
    files: [],
    credentials: [],
    createdAt: now,
    updatedAt: now,
  };
  environments.push(environment);
  return environment;
}

/** Adds the file, or replaces the contents of one with the same name. */
async function upsertFileByName(
  environment: StoredProjectEnvironment,
  fileName: string,
  content: string,
): Promise<void> {
  const record: StoredEnvFile = {
    id: environment.files.find((f) => f.fileName === fileName)?.id ?? randomUUID(),
    fileName,
    keyCount: countDotenvKeys(content),
    contentEnvelope: await encryptSecret(content),
    updatedAt: Date.now(),
  };
  const index = environment.files.findIndex((f) => f.id === record.id);
  if (index >= 0) environment.files[index] = record;
  else environment.files.push(record);
  environment.updatedAt = record.updatedAt;
}

/** undefined keeps the stored value, an empty string removes it, anything else replaces it. */
async function nextEnvelope(
  value: string | undefined,
  current: SecretEnvelope | undefined,
): Promise<SecretEnvelope | undefined> {
  if (value === undefined) return current;
  if (value === '') return undefined;
  return encryptSecret(value);
}

export function registerEnvironmentHandlers(): void {
  ipcMain.handle(
    IPC.environments.list,
    async (_event, projectId: string): Promise<ProjectEnvironment[]> =>
      (await store.getProjectEnvironments())
        .filter((e) => e.projectId === projectId)
        .sort((a, b) => a.order - b.order)
        .map(toPublicEnvironment),
  );

  ipcMain.handle(
    IPC.environments.save,
    (_event, input: SaveEnvironmentInput): Promise<ProjectEnvironment> =>
      mutate(async (environments) => {
        if (!input.id) {
          await requireProject(input.projectId);
          return toPublicEnvironment(
            newEnvironment(environments, input.projectId, input.name, input.kind),
          );
        }
        const environment = findEnvironment(environments, input.id);
        environment.name = cleanName(input.name);
        environment.kind = cleanKind(input.kind);
        environment.updatedAt = Date.now();
        return toPublicEnvironment(environment);
      }),
  );

  ipcMain.handle(IPC.environments.remove, async (_event, id: string): Promise<void> => {
    await mutate((environments) => {
      const index = environments.findIndex((e) => e.id === id);
      if (index >= 0) environments.splice(index, 1);
    });
    // A healthcheck of this environment stays, just no longer tied to it.
    await pruneOrphanHealthTargets({ environmentIds: [id] });
  });

  ipcMain.handle(
    IPC.environments.reorder,
    (_event, projectId: string, orderedIds: string[]): Promise<void> =>
      mutate((environments) => {
        for (const environment of environments) {
          if (environment.projectId !== projectId) continue;
          const position = orderedIds.indexOf(environment.id);
          if (position >= 0) environment.order = position;
        }
      }),
  );

  ipcMain.handle(
    IPC.environments.saveFile,
    (_event, input: SaveEnvFileInput): Promise<ProjectEnvironment> =>
      mutate(async (environments) => {
        const environment = findEnvironment(environments, input.environmentId);
        assertFileName(input.fileName);
        assertContentSize(input.content);
        const clash = environment.files.find(
          (f) => f.fileName === input.fileName && f.id !== input.id,
        );
        if (clash) throw new Error(`${input.fileName} is already saved in this environment.`);

        const index = input.id ? environment.files.findIndex((f) => f.id === input.id) : -1;
        const record: StoredEnvFile = {
          id: index >= 0 ? environment.files[index].id : randomUUID(),
          fileName: input.fileName,
          keyCount: countDotenvKeys(input.content),
          contentEnvelope: await encryptSecret(input.content),
          updatedAt: Date.now(),
        };
        if (index >= 0) environment.files[index] = record;
        else environment.files.push(record);
        environment.updatedAt = record.updatedAt;
        return toPublicEnvironment(environment);
      }),
  );

  ipcMain.handle(
    IPC.environments.removeFile,
    (_event, environmentId: string, fileId: string): Promise<void> =>
      mutate((environments) => {
        const environment = findEnvironment(environments, environmentId);
        environment.files = environment.files.filter((f) => f.id !== fileId);
        environment.updatedAt = Date.now();
      }),
  );

  ipcMain.handle(
    IPC.environments.readFile,
    async (_event, environmentId: string, fileId: string): Promise<string> => {
      const file = findFile(await readEnvironment(environmentId), fileId);
      return decryptSecret(file.contentEnvelope);
    },
  );

  // Copying happens here so the plaintext never has to pass through the renderer.
  ipcMain.handle(
    IPC.environments.copyFile,
    async (_event, environmentId: string, fileId: string): Promise<void> => {
      const file = findFile(await readEnvironment(environmentId), fileId);
      clipboard.writeText(await decryptSecret(file.contentEnvelope));
    },
  );

  ipcMain.handle(
    IPC.environments.saveCredential,
    (_event, input: SaveEnvCredentialInput): Promise<ProjectEnvironment> =>
      mutate(async (environments) => {
        const environment = findEnvironment(environments, input.environmentId);
        const label = String(input.label ?? '').trim();
        if (!label) throw new Error('Give the credential a label.');
        const existing = input.id ? findCredential(environment, input.id) : undefined;

        const record: StoredEnvCredential = {
          id: existing?.id ?? randomUUID(),
          label: label.slice(0, 120),
          username: String(input.username ?? '').trim(),
          url: String(input.url ?? '').trim(),
          secretEnvelope: await nextEnvelope(input.secret, existing?.secretEnvelope),
          notesEnvelope: await nextEnvelope(input.notes, existing?.notesEnvelope),
          updatedAt: Date.now(),
        };
        const index = environment.credentials.findIndex((c) => c.id === record.id);
        if (index >= 0) environment.credentials[index] = record;
        else environment.credentials.push(record);
        environment.updatedAt = record.updatedAt;
        return toPublicEnvironment(environment);
      }),
  );

  ipcMain.handle(
    IPC.environments.removeCredential,
    (_event, environmentId: string, credentialId: string): Promise<void> =>
      mutate((environments) => {
        const environment = findEnvironment(environments, environmentId);
        environment.credentials = environment.credentials.filter((c) => c.id !== credentialId);
        environment.updatedAt = Date.now();
      }),
  );

  ipcMain.handle(
    IPC.environments.revealCredential,
    async (_event, environmentId: string, credentialId: string): Promise<EnvCredentialSecrets> => {
      const credential = findCredential(await readEnvironment(environmentId), credentialId);
      return {
        secret: credential.secretEnvelope ? await decryptSecret(credential.secretEnvelope) : '',
        notes: credential.notesEnvelope ? await decryptSecret(credential.notesEnvelope) : '',
      };
    },
  );

  ipcMain.handle(
    IPC.environments.copyCredentialSecret,
    async (_event, environmentId: string, credentialId: string): Promise<void> => {
      const credential = findCredential(await readEnvironment(environmentId), credentialId);
      if (!credential.secretEnvelope) throw new Error('No password is saved for that credential.');
      clipboard.writeText(await decryptSecret(credential.secretEnvelope));
    },
  );

  ipcMain.handle(
    IPC.environments.scanFolder,
    async (_event, projectId: string): Promise<EnvFolderFile[]> => {
      const project = await requireProject(projectId);
      const saved = (await store.getProjectEnvironments()).filter((e) => e.projectId === projectId);
      const entries = await readdir(project.folderPath, { withFileTypes: true });
      const files: EnvFolderFile[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !isEnvFileName(entry.name)) continue;
        const { size } = await stat(join(project.folderPath, entry.name));
        files.push({
          fileName: entry.name,
          size,
          guessedKind: guessEnvironmentKind(entry.name),
          isTemplate: isEnvTemplateFileName(entry.name),
          tooLarge: size > MAX_ENV_FILE_BYTES,
          savedInEnvironmentId: saved.find((e) => e.files.some((f) => f.fileName === entry.name))
            ?.id,
        });
      }
      return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
    },
  );

  ipcMain.handle(
    IPC.environments.importFromFolder,
    async (_event, projectId: string, picks: EnvImportPick[]): Promise<EnvImportResult> => {
      const project = await requireProject(projectId);
      return mutate(async (environments) => {
        const errors: string[] = [];
        let imported = 0;
        // Several files can ask for the same new environment; they should land in one.
        const created = new Map<string, StoredProjectEnvironment>();

        for (const pick of picks) {
          try {
            assertFileName(pick.fileName);
            const path = join(project.folderPath, pick.fileName);
            if ((await stat(path)).size > MAX_ENV_FILE_BYTES) {
              throw new Error('it is larger than 1 MB');
            }
            const content = await readFile(path, 'utf-8');

            let target: StoredProjectEnvironment;
            if (pick.environmentId) {
              target = findEnvironment(environments, pick.environmentId);
              if (target.projectId !== projectId) throw new Error('wrong project');
            } else if (pick.newEnvironment) {
              const key = `${pick.newEnvironment.kind}:${pick.newEnvironment.name.trim().toLowerCase()}`;
              target =
                created.get(key) ??
                newEnvironment(
                  environments,
                  projectId,
                  pick.newEnvironment.name,
                  pick.newEnvironment.kind,
                );
              created.set(key, target);
            } else {
              throw new Error('no environment chosen');
            }

            await upsertFileByName(target, pick.fileName, content);
            imported++;
          } catch (error) {
            errors.push(
              `${pick.fileName}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return { imported, errors };
      });
    },
  );

  ipcMain.handle(
    IPC.environments.writeToFolder,
    async (
      _event,
      environmentId: string,
      fileId: string,
      overwrite: boolean,
    ): Promise<EnvWriteResult> => {
      const environment = await readEnvironment(environmentId);
      const file = findFile(environment, fileId);
      const project = await requireProject(environment.projectId);
      assertFileName(file.fileName);
      const path = join(project.folderPath, file.fileName);

      const exists = await stat(path).then(
        () => true,
        () => false,
      );
      if (exists && !overwrite) return { status: 'exists', path };

      await writeFile(path, await decryptSecret(file.contentEnvelope), 'utf-8');

      // `check-ignore` exits non-zero when the path is not ignored, which gitOrNull turns into null.
      const notIgnored =
        (await isGitRepo(project.folderPath)) &&
        (await gitOrNull(project.folderPath, ['check-ignore', '-q', '--', file.fileName])) === null;
      return { status: 'written', path, notIgnored };
    },
  );
}
