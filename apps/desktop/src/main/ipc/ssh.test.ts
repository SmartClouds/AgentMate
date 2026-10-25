import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredSshServer } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { sshErrorCode } from '../../shared/sshErrors';
import type { SshHostKeyStatus } from '../../shared/sshHostKey';
import { fakeWebContents } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import { invoke, invokeFrom, loadIpc, useTempUserData } from '../../test/main/ipcHarness';
import {
  type FakeSshServer,
  generateClientKey,
  startFakeSshServer,
} from '../ssh/testing/fakeSshServer';

/**
 * Trusting a changed host key is a security decision, so it is explicit: the renderer shows both
 * fingerprints and only then trusts the key, and main re-reads the key before storing it, so it
 * can never store a key the user did not see.
 */

// The SFTP file manager's sessions are main/sftp's own business; here only the hook is checked.
vi.mock('../sftp', () => ({ closeSftpSessionsForServer: vi.fn() }));

const userData = useTempUserData();
let server: FakeSshServer;
let ssh: typeof import('./ssh');

function saved(overrides: Partial<StoredSshServer> = {}): StoredSshServer {
  return {
    id: 'srv-1',
    nickname: 'prod',
    host: server.host,
    port: server.port,
    username: 'deploy',
    authMethod: 'password',
    createdAt: 1,
    lastConnectedAt: null,
    ...overrides,
  };
}

function storedServers(): StoredSshServer[] {
  return JSON.parse(readFileSync(userData.dataFile('ssh-servers.json'), 'utf-8'));
}

beforeEach(async () => {
  server = await startFakeSshServer();
  ssh = await loadIpc(
    () => import('./ssh'),
    (module) => module.registerSshHandlers(),
  );
});

afterEach(async () => {
  ssh.killAllSshSessions();
  await server.close();
});

describe('ssh:removeServer', () => {
  it('forgets the server and closes its SFTP sessions', async () => {
    userData.writeData('ssh-servers.json', [saved(), saved({ id: 'srv-2', nickname: 'stage' })]);
    // Imported after loadIpc, so this is the mock ssh.ts was given.
    const sftp = await import('../sftp');
    let storedWhenClosed: string[] = [];
    vi.mocked(sftp.closeSftpSessionsForServer).mockImplementation(() => {
      storedWhenClosed = storedServers().map((one) => one.id);
    });

    await invoke(IPC.ssh.removeServer, 'srv-1');

    expect(sftp.closeSftpSessionsForServer).toHaveBeenCalledWith('srv-1');
    expect(storedServers().map((one) => one.id)).toEqual(['srv-2']);
    // The server is gone from the store first, so an open racing the removal cannot find it.
    expect(storedWhenClosed).toEqual(['srv-2']);
  });

  it('tells whoever listens which server is gone, until they stop listening', async () => {
    userData.writeData('ssh-servers.json', [saved(), saved({ id: 'srv-2', nickname: 'stage' })]);
    const removed: string[] = [];
    const stop = ssh.onSshServerRemoved((id) => removed.push(id));

    await invoke(IPC.ssh.removeServer, 'srv-1');
    stop();
    await invoke(IPC.ssh.removeServer, 'srv-2');

    expect(removed).toEqual(['srv-1']);
  });
});

describe('ssh:reorderServers', () => {
  const three = () => [
    saved({ secretEnvelope: { mode: 'safeStorage', ciphertext: 'c2VjcmV0' } }),
    saved({ id: 'srv-2', nickname: 'stage' }),
    saved({ id: 'srv-3', nickname: 'dev' }),
  ];

  it('saves the servers in the order it is given and returns them', async () => {
    userData.writeData('ssh-servers.json', three());

    const reordered = (await invoke(IPC.ssh.reorderServers, ['srv-3', 'srv-1', 'srv-2'])) as {
      id: string;
    }[];

    expect(reordered.map((one) => one.id)).toEqual(['srv-3', 'srv-1', 'srv-2']);
    expect(storedServers().map((one) => one.id)).toEqual(['srv-3', 'srv-1', 'srv-2']);
  });

  it('never hands the renderer a stored secret', async () => {
    userData.writeData('ssh-servers.json', three());

    const reordered = (await invoke(IPC.ssh.reorderServers, ['srv-1', 'srv-2', 'srv-3'])) as {
      hasSecret: boolean;
    }[];

    expect(reordered[0]).toMatchObject({ hasSecret: true });
    expect(reordered[0]).not.toHaveProperty('secretEnvelope');
    // On disk the secret stays, so a reorder does not forget anybody's password.
    expect(storedServers()[0].secretEnvelope).toBeDefined();
  });

  it('keeps a server the list leaves out, after the ones it lists', async () => {
    userData.writeData('ssh-servers.json', three());

    await invoke(IPC.ssh.reorderServers, ['srv-2']);

    expect(storedServers().map((one) => one.id)).toEqual(['srv-2', 'srv-1', 'srv-3']);
  });
});

describe('ssh:hostKeyStatus', () => {
  it('reports the stored key and the key the server presents now', async () => {
    userData.writeData('ssh-servers.json', [saved({ hostKeyFingerprint: 'ab'.repeat(32) })]);

    const status = (await invoke(IPC.ssh.hostKeyStatus, 'srv-1')) as SshHostKeyStatus;

    expect(status).toEqual({
      serverId: 'srv-1',
      nickname: 'prod',
      host: server.host,
      port: server.port,
      stored: 'ab'.repeat(32),
      presented: server.fingerprint(),
    });
  });

  it('reports no stored key for a server never connected to', async () => {
    userData.writeData('ssh-servers.json', [saved()]);

    const status = (await invoke(IPC.ssh.hostKeyStatus, 'srv-1')) as SshHostKeyStatus;

    expect(status.stored).toBeNull();
  });

  it('refuses a server id it does not know', async () => {
    userData.writeData('ssh-servers.json', [saved()]);

    await expect(invoke(IPC.ssh.hostKeyStatus, 'srv-gone')).rejects.toThrow(
      'This saved server no longer exists.',
    );
  });
});

describe('ssh:trustHostKey', () => {
  it('stores the key the server presents', async () => {
    userData.writeData('ssh-servers.json', [saved({ hostKeyFingerprint: 'ab'.repeat(32) })]);

    await invoke(IPC.ssh.trustHostKey, 'srv-1', server.fingerprint());

    expect(storedServers()[0].hostKeyFingerprint).toBe(server.fingerprint());
  });

  it('refuses a key the server no longer presents', async () => {
    userData.writeData('ssh-servers.json', [saved({ hostKeyFingerprint: 'ab'.repeat(32) })]);
    const seen = server.fingerprint();
    await server.rotateHostKey();

    await expect(invoke(IPC.ssh.trustHostKey, 'srv-1', seen)).rejects.toThrow(
      /presented a different key/,
    );
    expect(storedServers()[0].hostKeyFingerprint).toBe('ab'.repeat(32));
  });

  it.each([['not-a-fingerprint'], [42], [null]])('refuses %j as a fingerprint', async (value) => {
    userData.writeData('ssh-servers.json', [saved()]);

    await expect(invoke(IPC.ssh.trustHostKey, 'srv-1', value)).rejects.toThrow(
      /not a host key fingerprint/,
    );
  });
});

describe('ssh:saveServer and the trusted key', () => {
  it('keeps the trusted key when the address stays the same', async () => {
    userData.writeData('ssh-servers.json', [saved({ hostKeyFingerprint: 'ab'.repeat(32) })]);

    await invoke(IPC.ssh.saveServer, {
      id: 'srv-1',
      nickname: 'renamed',
      host: server.host,
      port: server.port,
      username: 'deploy',
      authMethod: 'password',
    });

    expect(storedServers()[0].hostKeyFingerprint).toBe('ab'.repeat(32));
  });

  it('forgets the trusted key when the address changes', async () => {
    userData.writeData('ssh-servers.json', [saved({ hostKeyFingerprint: 'ab'.repeat(32) })]);

    await invoke(IPC.ssh.saveServer, {
      id: 'srv-1',
      nickname: 'prod',
      host: 'other.example',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
    });

    expect(storedServers()[0].hostKeyFingerprint).toBeUndefined();
  });
});

describe('ssh:create', () => {
  it('types the initial input into the new shell', async () => {
    // A resumed conversation opens as an SSH tab that types its own resume command.
    const key = generateClientKey();
    await server.close();
    server = await startFakeSshServer({ authorizedKey: key.publicKey });
    const keyPath = join(tempDir(), 'id_ed25519');
    writeFileSync(keyPath, key.privateKey);
    userData.writeData('ssh-servers.json', [
      saved({ authMethod: 'privateKey', privateKeyPath: keyPath }),
    ]);
    const sender = fakeWebContents();

    await invokeFrom(sender, IPC.ssh.create, {
      savedServerId: 'srv-1',
      initialInput: 'claude --resume abc-12345\r',
    });

    await vi.waitFor(() => {
      const output = sender
        .sentOn(IPC.ssh.onData)
        .map((args) => (args[0] as { data: string }).data)
        .join('');
      expect(output).toContain('claude --resume abc-12345');
    });
  });
});

describe('ssh:conversations', () => {
  it.each([[42], [null], ['']])('refuses %j as a server id', async (value) => {
    await expect(invoke(IPC.ssh.conversations, value)).rejects.toThrow(/not a saved server/);
  });

  it('refuses a server id it does not know', async () => {
    userData.writeData('ssh-servers.json', [saved()]);

    await expect(invoke(IPC.ssh.conversations, 'srv-gone')).rejects.toThrow(
      'This saved server no longer exists.',
    );
  });

  it('keeps the code of a changed host key, so the renderer can offer to check it', async () => {
    userData.writeData('ssh-servers.json', [saved({ hostKeyFingerprint: 'ab'.repeat(32) })]);

    await expect(invoke(IPC.ssh.conversations, 'srv-1')).rejects.toSatisfy(
      (error) => sshErrorCode(error) === 'host-key-changed',
    );
  });

  it('marks a locked Servers vault, so the renderer can ask for the passkey', async () => {
    const vault = await import('../ssh/vault');
    expect((await vault.setPasskey('a servers passkey')).ok).toBe(true);
    userData.writeData('ssh-servers.json', [
      saved({ secretEnvelope: await vault.encryptSecret('the login password') }),
    ]);
    vault.lockVault();

    await expect(invoke(IPC.ssh.conversations, 'srv-1')).rejects.toSatisfy(
      (error) => sshErrorCode(error) === 'vault-locked',
    );
  });
});

describe('ssh:typePassword', () => {
  const PASSWORD = 'correct horse battery staple';

  async function openPasswordSession(): Promise<ReturnType<typeof fakeWebContents>> {
    const vault = await import('../ssh/vault');
    userData.writeData('ssh-servers.json', [
      saved({ secretEnvelope: await vault.encryptSecret(PASSWORD) }),
    ]);
    const sender = fakeWebContents();
    await invokeFrom(sender, IPC.ssh.create, { sessionId: 'tab-1', savedServerId: 'srv-1' });
    await vi.waitFor(() => expect(server.shells).toHaveLength(1));
    return sender;
  }

  function promptEvents(sender: ReturnType<typeof fakeWebContents>): boolean[] {
    return sender
      .sentOn(IPC.ssh.onPasswordPrompt)
      .map((args) => (args[0] as { prompting: boolean }).prompting);
  }

  it('offers the button on a sudo prompt and types the saved password into it', async () => {
    const sender = await openPasswordSession();
    const received: string[] = [];
    server.shells[0].on('data', (data: Buffer) => received.push(data.toString()));

    server.shells[0].write('[sudo] password for deploy: ');
    await vi.waitFor(() => expect(promptEvents(sender)).toEqual([true]));

    await expect(invoke(IPC.ssh.typePassword, 'tab-1')).resolves.toBe(true);

    expect(promptEvents(sender)).toEqual([true, false]);
    await vi.waitFor(() => expect(received.join('')).toBe(`${PASSWORD}\n`));
  });

  it('takes the button away once the prompt is answered some other way', async () => {
    const sender = await openPasswordSession();

    server.shells[0].write('Password: ');
    await vi.waitFor(() => expect(promptEvents(sender)).toEqual([true]));
    server.shells[0].write('\r\nsu: Authentication failure\r\n$ ');

    await vi.waitFor(() => expect(promptEvents(sender)).toEqual([true, false]));
  });

  it('never offers it to a key login, which has no password to type', async () => {
    const key = generateClientKey();
    await server.close();
    server = await startFakeSshServer({ authorizedKey: key.publicKey });
    const keyPath = join(tempDir(), 'id_ed25519');
    writeFileSync(keyPath, key.privateKey);
    userData.writeData('ssh-servers.json', [
      saved({ authMethod: 'privateKey', privateKeyPath: keyPath }),
    ]);
    const sender = fakeWebContents();
    await invokeFrom(sender, IPC.ssh.create, { sessionId: 'tab-1', savedServerId: 'srv-1' });
    // A key login's handshake is the slow one, and under a full parallel run it outlasts the
    // default second of vi.waitFor.
    await vi.waitFor(() => expect(server.shells).toHaveLength(1), { timeout: 10_000 });

    server.shells[0].write('[sudo] password for deploy: ');
    await vi.waitFor(
      () =>
        expect(
          sender
            .sentOn(IPC.ssh.onData)
            .map((args) => (args[0] as { data: string }).data)
            .join(''),
        ).toContain('password for deploy'),
      { timeout: 10_000 },
    );

    expect(promptEvents(sender)).toEqual([]);
    await expect(invoke(IPC.ssh.typePassword, 'tab-1')).resolves.toBe(false);
  });
});
