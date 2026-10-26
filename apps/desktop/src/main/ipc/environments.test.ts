import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  EnvCredentialSecrets,
  EnvFolderFile,
  EnvImportResult,
  EnvWriteResult,
  ProjectEnvironment,
  StoredProjectEnvironment,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { initGitRepo, tempDir } from '../../test/main/fixtures';
import {
  electronState,
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';
import { deriveKey, encryptWithKey } from '../crypto/aesGcm';
import { store } from '../store';

/**
 * Project environments: the .env files and credentials the app keeps for a project. Secrets are
 * only ever stored encrypted, so each test checks the ciphertext on disk as well as what comes
 * back through the handler. safeStorage is the reversible stand-in from the electron mock, which
 * is asymmetric enough to catch code that forgets to encrypt or decrypt.
 */

const userData = useTempUserData();
const project = { dir: '' };
let environmentsModule: typeof import('./environments');
const PROJECT_ID = 'p1';
const SECRET = 'API_TOKEN=do-not-log-me\n';

expectChannelsCovered(IPC.environments);

function storedEnvironments(): StoredProjectEnvironment[] {
  return JSON.parse(
    readFileSync(userData.dataFile('project-environments.json'), 'utf-8'),
  ) as StoredProjectEnvironment[];
}

async function newEnvironment(name = 'Production'): Promise<ProjectEnvironment> {
  return invoke<ProjectEnvironment>(IPC.environments.save, {
    projectId: PROJECT_ID,
    name,
    kind: 'production',
  });
}

beforeEach(async () => {
  project.dir = tempDir('runova-env-project-');
  userData.writeData('projects.json', [
    { id: PROJECT_ID, name: 'Demo', folderPath: project.dir, createdAt: '2026-01-01T00:00:00Z' },
  ]);
  // The passkey cache lives in the module rather than on disk, and the harness rebuilds the
  // module graph per test, so every test starts with the vault locked.
  environmentsModule = await loadIpc(
    () => import('./environments'),
    (module) => module.registerEnvironmentHandlers(),
  );
});

describe('resolveProjectEnvironment (main process only)', () => {
  it('decrypts every file and merges the keys, the later file winning', async () => {
    const created = await newEnvironment();
    await invoke(IPC.environments.saveFile, {
      environmentId: created.id,
      fileName: '.env',
      content: 'A=1\nSHARED=from-env\n',
    });
    // Not awaited: the read waits for the save already queued.
    const pending = invoke(IPC.environments.saveFile, {
      environmentId: created.id,
      fileName: '.env.production',
      content: 'SHARED="from production"\nB=2\n',
    });
    const resolved = await environmentsModule.resolveProjectEnvironment(PROJECT_ID, created.id);
    await pending;
    expect(resolved.name).toBe('Production');
    expect(resolved.files.map((file) => file.fileName)).toEqual(['.env', '.env.production']);
    expect(resolved.entries).toEqual([
      { key: 'A', value: '1' },
      { key: 'SHARED', value: 'from production' },
      { key: 'B', value: '2' },
    ]);
  });

  it("refuses another project's environment and one that is gone", async () => {
    const created = await newEnvironment();
    await expect(environmentsModule.resolveProjectEnvironment('other', created.id)).rejects.toThrow(
      'That environment belongs to another project.',
    );
    await expect(environmentsModule.resolveProjectEnvironment(PROJECT_ID, 'gone')).rejects.toThrow(
      'That environment no longer exists.',
    );
  });
});

describe('environments CRUD', () => {
  it('creates an environment for a project and lists it back', async () => {
    const created = await newEnvironment();
    expect(created).toMatchObject({
      projectId: PROJECT_ID,
      name: 'Production',
      kind: 'production',
      order: 0,
      files: [],
      credentials: [],
    });
    expect(await invoke<ProjectEnvironment[]>(IPC.environments.list, PROJECT_ID)).toEqual([
      created,
    ]);
    // Another project's list never sees it.
    expect(await invoke<ProjectEnvironment[]>(IPC.environments.list, 'other')).toEqual([]);
  });

  it('refuses an environment for a project that is gone, and one with no name', async () => {
    await expect(
      invoke(IPC.environments.save, { projectId: 'missing', name: 'X', kind: 'custom' }),
    ).rejects.toThrow('That project no longer exists.');
    await expect(
      invoke(IPC.environments.save, { projectId: PROJECT_ID, name: '   ', kind: 'custom' }),
    ).rejects.toThrow('Give the environment a name.');
  });

  it('trims the name, caps its length and falls back to the custom kind', async () => {
    const created = await invoke<ProjectEnvironment>(IPC.environments.save, {
      projectId: PROJECT_ID,
      name: `  ${'x'.repeat(80)}  `,
      kind: 'not-a-kind',
    });
    expect(created.name).toHaveLength(60);
    expect(created.kind).toBe('custom');
  });

  it('renames an existing environment rather than adding another', async () => {
    const created = await newEnvironment();
    const renamed = await invoke<ProjectEnvironment>(IPC.environments.save, {
      id: created.id,
      projectId: PROJECT_ID,
      name: 'Staging',
      kind: 'staging',
    });
    expect(renamed.id).toBe(created.id);
    expect(await invoke<ProjectEnvironment[]>(IPC.environments.list, PROJECT_ID)).toHaveLength(1);
    expect(storedEnvironments()[0].name).toBe('Staging');
  });

  it('removes one, and ignores an id it does not know', async () => {
    const created = await newEnvironment();
    await invoke(IPC.environments.remove, 'never-existed');
    await invoke(IPC.environments.remove, created.id);
    expect(await invoke<ProjectEnvironment[]>(IPC.environments.list, PROJECT_ID)).toEqual([]);
  });

  it('reorders by the ids given and leaves other projects alone', async () => {
    const first = await newEnvironment('First');
    const second = await newEnvironment('Second');
    await invoke(IPC.environments.reorder, PROJECT_ID, [second.id, first.id]);
    expect(
      (await invoke<ProjectEnvironment[]>(IPC.environments.list, PROJECT_ID)).map((e) => e.name),
    ).toEqual(['Second', 'First']);
  });

  it('refuses to edit an environment that no longer exists', async () => {
    await expect(
      invoke(IPC.environments.saveFile, {
        environmentId: 'gone',
        fileName: '.env',
        content: 'A=1',
      }),
    ).rejects.toThrow('That environment no longer exists.');
  });
});

describe('environment files', () => {
  it('encrypts the contents on disk and only decrypts them through readFile', async () => {
    const environment = await newEnvironment();
    const saved = await invoke<ProjectEnvironment>(IPC.environments.saveFile, {
      environmentId: environment.id,
      fileName: '.env.production',
      content: SECRET,
    });
    // The summary the renderer gets carries no contents, just the key count.
    expect(saved.files).toEqual([
      expect.objectContaining({ fileName: '.env.production', keyCount: 1 }),
    ]);
    expect(JSON.stringify(saved)).not.toContain('do-not-log-me');

    const onDisk = storedEnvironments()[0].files[0];
    expect(onDisk.contentEnvelope.mode).toBe('safeStorage');
    expect(readFileSync(userData.dataFile('project-environments.json'), 'utf-8')).not.toContain(
      'do-not-log-me',
    );

    expect(await invoke<string>(IPC.environments.readFile, environment.id, saved.files[0].id)).toBe(
      SECRET,
    );
  });

  it('replaces the file when saved again with the same id', async () => {
    const environment = await newEnvironment();
    const first = await invoke<ProjectEnvironment>(IPC.environments.saveFile, {
      environmentId: environment.id,
      fileName: '.env',
      content: 'A=1\n',
    });
    const updated = await invoke<ProjectEnvironment>(IPC.environments.saveFile, {
      id: first.files[0].id,
      environmentId: environment.id,
      fileName: '.env',
      content: 'A=1\nB=2\n',
    });
    expect(updated.files).toHaveLength(1);
    expect(updated.files[0].keyCount).toBe(2);
  });

  it('refuses a second file with the same name, a name with a folder in it, and a huge one', async () => {
    const environment = await newEnvironment();
    await invoke(IPC.environments.saveFile, {
      environmentId: environment.id,
      fileName: '.env',
      content: 'A=1',
    });
    await expect(
      invoke(IPC.environments.saveFile, {
        environmentId: environment.id,
        fileName: '.env',
        content: 'B=2',
      }),
    ).rejects.toThrow('.env is already saved in this environment.');
    await expect(
      invoke(IPC.environments.saveFile, {
        environmentId: environment.id,
        fileName: '../../.ssh/id_rsa',
        content: 'x',
      }),
    ).rejects.toThrow('Use a file name like .env');
    await expect(
      invoke(IPC.environments.saveFile, {
        environmentId: environment.id,
        fileName: '.env.big',
        content: 'x'.repeat(1024 * 1024 + 1),
      }),
    ).rejects.toThrow('larger than 1 MB');
  });

  it('removes a file, and reports one that is already gone', async () => {
    const environment = await newEnvironment();
    const saved = await invoke<ProjectEnvironment>(IPC.environments.saveFile, {
      environmentId: environment.id,
      fileName: '.env',
      content: 'A=1',
    });
    await invoke(IPC.environments.removeFile, environment.id, saved.files[0].id);
    expect(storedEnvironments()[0].files).toEqual([]);
    await expect(
      invoke(IPC.environments.readFile, environment.id, saved.files[0].id),
    ).rejects.toThrow('That env file no longer exists.');
  });

  it('copies the contents straight to the clipboard, so the renderer never sees them', async () => {
    const environment = await newEnvironment();
    const saved = await invoke<ProjectEnvironment>(IPC.environments.saveFile, {
      environmentId: environment.id,
      fileName: '.env',
      content: SECRET,
    });
    await invoke(IPC.environments.copyFile, environment.id, saved.files[0].id);
    expect(electronState.clipboardText).toBe(SECRET);
  });
});

describe('environment credentials', () => {
  it('stores the secret and notes encrypted and reveals them on request', async () => {
    const environment = await newEnvironment();
    const saved = await invoke<ProjectEnvironment>(IPC.environments.saveCredential, {
      environmentId: environment.id,
      label: '  Database  ',
      username: ' app ',
      url: ' postgres://db.test ',
      secret: 'db-password',
      notes: 'rotate quarterly',
    });
    expect(saved.credentials).toEqual([
      expect.objectContaining({
        label: 'Database',
        username: 'app',
        url: 'postgres://db.test',
        hasSecret: true,
        hasNotes: true,
      }),
    ]);
    expect(JSON.stringify(saved)).not.toContain('db-password');

    expect(
      await invoke<EnvCredentialSecrets>(
        IPC.environments.revealCredential,
        environment.id,
        saved.credentials[0].id,
      ),
    ).toEqual({ secret: 'db-password', notes: 'rotate quarterly' });
  });

  it('keeps an unchanged secret, and an empty string clears it', async () => {
    const environment = await newEnvironment();
    const created = await invoke<ProjectEnvironment>(IPC.environments.saveCredential, {
      environmentId: environment.id,
      label: 'API',
      secret: 'keep-me',
      notes: 'note',
    });
    const credentialId = created.credentials[0].id;

    // undefined means "the user did not touch this field".
    const renamed = await invoke<ProjectEnvironment>(IPC.environments.saveCredential, {
      id: credentialId,
      environmentId: environment.id,
      label: 'API key',
    });
    expect(renamed.credentials[0]).toMatchObject({ label: 'API key', hasSecret: true });
    expect(
      await invoke<EnvCredentialSecrets>(
        IPC.environments.revealCredential,
        environment.id,
        credentialId,
      ),
    ).toMatchObject({ secret: 'keep-me' });

    const cleared = await invoke<ProjectEnvironment>(IPC.environments.saveCredential, {
      id: credentialId,
      environmentId: environment.id,
      label: 'API key',
      secret: '',
      notes: '',
    });
    expect(cleared.credentials[0]).toMatchObject({ hasSecret: false, hasNotes: false });
  });

  it('needs a label, and refuses an unknown credential id', async () => {
    const environment = await newEnvironment();
    await expect(
      invoke(IPC.environments.saveCredential, { environmentId: environment.id, label: '  ' }),
    ).rejects.toThrow('Give the credential a label.');
    await expect(
      invoke(IPC.environments.saveCredential, {
        id: 'nope',
        environmentId: environment.id,
        label: 'X',
      }),
    ).rejects.toThrow('That credential no longer exists.');
  });

  it('copies the password to the clipboard, and says so when there is none', async () => {
    const environment = await newEnvironment();
    const withSecret = await invoke<ProjectEnvironment>(IPC.environments.saveCredential, {
      environmentId: environment.id,
      label: 'Has one',
      secret: 'copy-this',
    });
    await invoke(
      IPC.environments.copyCredentialSecret,
      environment.id,
      withSecret.credentials[0].id,
    );
    expect(electronState.clipboardText).toBe('copy-this');

    const without = await invoke<ProjectEnvironment>(IPC.environments.saveCredential, {
      environmentId: environment.id,
      label: 'Has none',
    });
    const id = without.credentials.find((c) => c.label === 'Has none')?.id;
    await expect(invoke(IPC.environments.copyCredentialSecret, environment.id, id)).rejects.toThrow(
      'No password is saved for that credential.',
    );
  });

  it('removes a credential', async () => {
    const environment = await newEnvironment();
    const saved = await invoke<ProjectEnvironment>(IPC.environments.saveCredential, {
      environmentId: environment.id,
      label: 'Temp',
      secret: 'x',
    });
    await invoke(IPC.environments.removeCredential, environment.id, saved.credentials[0].id);
    expect(storedEnvironments()[0].credentials).toEqual([]);
  });
});

describe('the project folder', () => {
  it('lists the env files sitting in the folder, with sizes and guessed kinds', async () => {
    writeFileSync(join(project.dir, '.env'), 'A=1\n', 'utf-8');
    writeFileSync(join(project.dir, '.env.production'), 'A=2\n', 'utf-8');
    writeFileSync(join(project.dir, '.env.example'), 'A=\n', 'utf-8');
    writeFileSync(join(project.dir, 'README.md'), 'not an env file', 'utf-8');

    const files = await invoke<EnvFolderFile[]>(IPC.environments.scanFolder, PROJECT_ID);
    expect(files.map((file) => file.fileName)).toEqual(['.env', '.env.example', '.env.production']);
    expect(files[0]).toMatchObject({
      guessedKind: 'development',
      isTemplate: false,
      tooLarge: false,
    });
    expect(files[1].isTemplate).toBe(true);
    expect(files[2].guessedKind).toBe('production');
    expect(files[0].savedInEnvironmentId).toBeUndefined();
  });

  it('imports picked files into a new environment and marks them as saved afterwards', async () => {
    writeFileSync(join(project.dir, '.env'), 'A=1\n', 'utf-8');
    writeFileSync(join(project.dir, '.env.production'), SECRET, 'utf-8');

    const result = await invoke<EnvImportResult>(IPC.environments.importFromFolder, PROJECT_ID, [
      { fileName: '.env', newEnvironment: { name: 'Local', kind: 'development' } },
      { fileName: '.env.production', newEnvironment: { name: 'Local', kind: 'development' } },
    ]);
    // Both picks named the same new environment, so they land in one.
    expect(result).toEqual({ imported: 2, errors: [] });
    const environments = await invoke<ProjectEnvironment[]>(IPC.environments.list, PROJECT_ID);
    expect(environments).toHaveLength(1);
    expect(environments[0].files.map((file) => file.fileName)).toEqual(['.env', '.env.production']);

    const scanned = await invoke<EnvFolderFile[]>(IPC.environments.scanFolder, PROJECT_ID);
    expect(scanned[0].savedInEnvironmentId).toBe(environments[0].id);
  });

  it('reports each pick that could not be imported without dropping the others', async () => {
    writeFileSync(join(project.dir, '.env'), 'A=1\n', 'utf-8');
    const target = await newEnvironment();

    const result = await invoke<EnvImportResult>(IPC.environments.importFromFolder, PROJECT_ID, [
      { fileName: '.env', environmentId: target.id },
      { fileName: '.env.missing', environmentId: target.id },
      { fileName: '../outside.env', environmentId: target.id },
      { fileName: '.env', environmentId: 'no-such-environment' },
      { fileName: '.env' },
    ]);
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(4);
    expect(result.errors[1]).toContain('Use a file name like .env');
    expect(result.errors[2]).toContain('That environment no longer exists.');
    expect(result.errors[3]).toContain('no environment chosen');
  });

  it('writes a saved file back into the folder, but only over an existing one when told to', async () => {
    const environment = await newEnvironment();
    const saved = await invoke<ProjectEnvironment>(IPC.environments.saveFile, {
      environmentId: environment.id,
      fileName: '.env',
      content: SECRET,
    });
    const fileId = saved.files[0].id;
    const path = join(project.dir, '.env');

    const written = await invoke<EnvWriteResult>(
      IPC.environments.writeToFolder,
      environment.id,
      fileId,
      false,
    );
    expect(written).toMatchObject({ status: 'written', path });
    expect(readFileSync(path, 'utf-8')).toBe(SECRET);

    // A second write without overwrite stops and hands the path back for a confirmation.
    writeFileSync(path, 'mine\n', 'utf-8');
    expect(
      await invoke<EnvWriteResult>(IPC.environments.writeToFolder, environment.id, fileId, false),
    ).toEqual({ status: 'exists', path });
    expect(readFileSync(path, 'utf-8')).toBe('mine\n');

    await invoke(IPC.environments.writeToFolder, environment.id, fileId, true);
    expect(readFileSync(path, 'utf-8')).toBe(SECRET);
  });

  it('warns when the written file is not gitignored', async () => {
    const repo = initGitRepo({ '.gitignore': '/.env.secret\n' });
    userData.writeData('projects.json', [
      { id: PROJECT_ID, name: 'Demo', folderPath: repo.dir, createdAt: '2026-01-01T00:00:00Z' },
    ]);
    const environment = await newEnvironment();

    const ignored = await invoke<ProjectEnvironment>(IPC.environments.saveFile, {
      environmentId: environment.id,
      fileName: '.env.secret',
      content: 'A=1\n',
    });
    expect(
      await invoke<EnvWriteResult>(
        IPC.environments.writeToFolder,
        environment.id,
        ignored.files[0].id,
        true,
      ),
    ).toMatchObject({ status: 'written', notIgnored: false });

    const exposed = await invoke<ProjectEnvironment>(IPC.environments.saveFile, {
      environmentId: environment.id,
      fileName: '.env',
      content: 'A=1\n',
    });
    const exposedId = exposed.files.find((file) => file.fileName === '.env')?.id;
    expect(
      await invoke<EnvWriteResult>(IPC.environments.writeToFolder, environment.id, exposedId, true),
    ).toMatchObject({ status: 'written', notIgnored: true });
  });
});

describe('when secure storage cannot be used', () => {
  it('refuses to save a secret rather than storing it in the clear', async () => {
    const environment = await newEnvironment();
    electronState.encryptionAvailable = false;
    await expect(
      invoke(IPC.environments.saveFile, {
        environmentId: environment.id,
        fileName: '.env',
        content: SECRET,
      }),
    ).rejects.toThrow('Secure storage is not available');
    expect(storedEnvironments()[0].files).toEqual([]);
  });

  it('says the vault is locked while a passkey is set but not unlocked', async () => {
    const environment = await newEnvironment();
    // A passkey the app has never been unlocked with: a real vault record on disk, and a
    // module graph that has never seen the passphrase.
    const salt = randomBytes(16).toString('base64');
    const key = await deriveKey('a passkey nobody typed', salt);
    const verifier = Buffer.from(
      JSON.stringify(encryptWithKey('agentmate-ssh-vault', key) /* legacy-name */),
      'utf-8',
    ).toString('base64');
    await store.setSshVault({ salt, verifier });

    await expect(
      invoke(IPC.environments.saveFile, {
        environmentId: environment.id,
        fileName: '.env',
        content: SECRET,
      }),
    ).rejects.toThrow('The vault is locked.');
  });
});
