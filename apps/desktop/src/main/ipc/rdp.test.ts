import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RdpCertificateCheckResult,
  RdpCertificateInfo,
  RdpFailureInfo,
  RdpStageResult,
  RdpStageStart,
  StoredRdpServer,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import { invoke, invokeFrom, loadIpc, useTempUserData } from '../../test/main/ipcHarness';
import { type HandshakeDeps, RdpHandshakeError } from '../rdp/handshake';
import type { RdpProxyHooks, RdpProxyTarget } from '../rdp/proxy';

/**
 * Closing a Remote Desktop window ends whatever AI task was driving it, and the certificate a
 * server presented is kept, compared, trusted or forgotten here, in the main process.
 */

const fakes = vi.hoisted(() => ({
  stopRdpTask: vi.fn(),
  onClosed: [] as (() => void)[],
  fetchServerCertificate: vi.fn(),
  hooks: null as null | RdpProxyHooks,
  proxyDeps: undefined as HandshakeDeps | undefined,
  /** The OS boundary of the files copied on the server: the folder and the Windows clipboard. */
  staging: { supported: true, folder: '' },
  putFilesOnClipboard: vi.fn(),
}));

vi.mock('../agents/rdpTaskRunner', () => ({ stopRdpTask: fakes.stopRdpTask }));
vi.mock('../rdp/remoteClipboard', () => ({
  MAX_STAGED_BYTES: 1000,
  stagingSupported: () => fakes.staging.supported,
  prepareStagingFolder: async () => fakes.staging.folder,
  putFilesOnClipboard: fakes.putFilesOnClipboard,
  sweepStaleStaging: async () => undefined,
}));
vi.mock('../rdp/clipboardFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rdp/clipboardFiles')>()),
  rawSignature: () => 'signature-of-staged-files',
}));
vi.mock('../rdp/sessionWindows', async () => {
  const { FakeBrowserWindow: Window } = await import('../../test/main/electronMock');
  return {
    openRdpWindow: (options: { onClosed: () => void }) => {
      fakes.onClosed.push(options.onClosed);
      return new Window();
    },
    closeAllRdpWindows: () => undefined,
  };
});
// The proxy is only here for the hooks it is given: the tests play the server's side by calling them.
vi.mock('../rdp/proxy', () => ({
  RdpProxy: class {
    constructor(hooks: RdpProxyHooks, deps?: HandshakeDeps) {
      fakes.hooks = hooks;
      fakes.proxyDeps = deps;
    }
    async issueUrl(): Promise<string> {
      return 'ws://127.0.0.1:1/token';
    }
    closeSession = (): undefined => undefined;
    shutdown = (): undefined => undefined;
  },
}));
vi.mock('../rdp/handshake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rdp/handshake')>()),
  fetchServerCertificate: fakes.fetchServerCertificate,
}));

const userData = useTempUserData({ home: false });

const NEW_CERTIFICATE: RdpCertificateInfo = {
  fingerprint: 'AA:11:22',
  subject: 'CN=WIN-NEW',
  issuer: 'CN=WIN-NEW',
  validTo: 'Apr 1 00:00:00 2027 GMT',
};

const OLD_CERTIFICATE = {
  fingerprint: 'BB:99:88',
  details: { subject: 'CN=WIN-OLD', issuer: 'CN=WIN-OLD', validTo: 'Jan 1 00:00:00 2026 GMT' },
};

function writeServer(extra: Partial<StoredRdpServer> = {}): void {
  userData.writeData('rdp-servers.json', [
    {
      id: 'server-1',
      nickname: 'Build box',
      host: '10.0.0.5',
      port: 3389,
      username: 'admin',
      options: { resolution: 'fitWindow' },
      createdAt: 0,
      lastConnectedAt: null,
      ...extra,
    },
  ]);
}

function savedServer(): StoredRdpServer {
  return (
    JSON.parse(readFileSync(userData.dataFile('rdp-servers.json'), 'utf-8')) as StoredRdpServer[]
  )[0];
}

async function load(): Promise<void> {
  await loadIpc(
    () => import('./rdp'),
    (module) => module.registerRdpHandlers(),
  );
}

beforeEach(async () => {
  fakes.stopRdpTask.mockClear();
  fakes.fetchServerCertificate.mockReset();
  fakes.onClosed.length = 0;
  fakes.hooks = null;
  writeServer();
  await load();
});

describe('a Remote Desktop session window', () => {
  it('stops its AI task when it closes', async () => {
    const sessionId = await invoke<string>(IPC.rdp.openSession, 'server-1');
    expect(FakeBrowserWindow.instances).toHaveLength(1);
    expect(fakes.stopRdpTask).not.toHaveBeenCalled();

    fakes.onClosed[0]?.();
    expect(fakes.stopRdpTask).toHaveBeenCalledWith(sessionId, 'exited');
  });
});

describe('what the proxy tells a session window', () => {
  const target = (sessionId: string): RdpProxyTarget => ({
    sessionId,
    host: '10.0.0.5',
    port: 3389,
  });

  it('forwards a failure with its code, sentence and details apart', async () => {
    const sessionId = await invoke<string>(IPC.rdp.openSession, 'server-1');
    const failure: RdpFailureInfo = {
      code: 'tls-key-usage',
      message: "The certificate 10.0.0.5:3389 presented can't be used.",
      detail: 'KEY_USAGE_BIT_INCORRECT (SSL routines)',
    };

    fakes.hooks?.onError(target(sessionId), failure);

    expect(FakeBrowserWindow.instances[0].webContents.sentOn(IPC.rdp.onProxyError)).toEqual([
      [{ sessionId, ...failure }],
    ]);
  });

  it('saves the certificate, with who it was issued to, the first time a server is seen', async () => {
    const sessionId = await invoke<string>(IPC.rdp.openSession, 'server-1');

    fakes.hooks?.onCertificateFirstSeen(target(sessionId), NEW_CERTIFICATE);

    await vi.waitFor(() => expect(savedServer().certFingerprint).toBe('AA:11:22'));
    expect(savedServer().certDetails).toEqual({
      subject: 'CN=WIN-NEW',
      issuer: 'CN=WIN-NEW',
      validTo: 'Apr 1 00:00:00 2027 GMT',
    });
  });

  it('keeps the old certificate until the person trusts the new one', async () => {
    writeServer({ certFingerprint: OLD_CERTIFICATE.fingerprint });
    await load();
    const sessionId = await invoke<string>(IPC.rdp.openSession, 'server-1');

    fakes.hooks?.onCertificateMismatch(target(sessionId), NEW_CERTIFICATE);
    const window = FakeBrowserWindow.instances[0];
    expect(window.webContents.sentOn(IPC.rdp.onCertificatePrompt)).toHaveLength(1);
    expect(savedServer().certFingerprint).toBe('BB:99:88');

    await invokeFrom(window.webContents, IPC.rdp.respondCertificate, sessionId, true);
    expect(savedServer()).toMatchObject({
      certFingerprint: 'AA:11:22',
      certDetails: { subject: 'CN=WIN-NEW' },
    });
  });

  it('leaves the old certificate saved when the person says no', async () => {
    writeServer({ certFingerprint: OLD_CERTIFICATE.fingerprint });
    await load();
    const sessionId = await invoke<string>(IPC.rdp.openSession, 'server-1');

    fakes.hooks?.onCertificateMismatch(target(sessionId), NEW_CERTIFICATE);
    await invokeFrom(
      FakeBrowserWindow.instances[0].webContents,
      IPC.rdp.respondCertificate,
      sessionId,
      false,
    );

    expect(savedServer().certFingerprint).toBe('BB:99:88');
  });

  it('can still trust the new certificate after saying no, when the failed screen asks again', async () => {
    writeServer({ certFingerprint: OLD_CERTIFICATE.fingerprint });
    await load();
    const sessionId = await invoke<string>(IPC.rdp.openSession, 'server-1');
    const window = FakeBrowserWindow.instances[0];

    fakes.hooks?.onCertificateMismatch(target(sessionId), NEW_CERTIFICATE);
    await invokeFrom(window.webContents, IPC.rdp.respondCertificate, sessionId, false);
    await invokeFrom(window.webContents, IPC.rdp.respondCertificate, sessionId, true);

    expect(savedServer()).toMatchObject({
      certFingerprint: 'AA:11:22',
      certDetails: { subject: 'CN=WIN-NEW' },
    });
  });

  it('has nothing to trust once the session connected', async () => {
    writeServer({ certFingerprint: OLD_CERTIFICATE.fingerprint });
    await load();
    const sessionId = await invoke<string>(IPC.rdp.openSession, 'server-1');

    fakes.hooks?.onCertificateMismatch(target(sessionId), NEW_CERTIFICATE);
    fakes.hooks?.onConnected(target(sessionId));
    await invokeFrom(
      FakeBrowserWindow.instances[0].webContents,
      IPC.rdp.respondCertificate,
      sessionId,
      true,
    );

    expect(savedServer().certFingerprint).toBe('BB:99:88');
  });

  it('trusts the newest certificate when the server shows another one on a later attempt', async () => {
    writeServer({ certFingerprint: OLD_CERTIFICATE.fingerprint });
    await load();
    const sessionId = await invoke<string>(IPC.rdp.openSession, 'server-1');

    fakes.hooks?.onCertificateMismatch(target(sessionId), NEW_CERTIFICATE);
    fakes.hooks?.onCertificateMismatch(target(sessionId), {
      ...NEW_CERTIFICATE,
      fingerprint: 'CC:33:44',
    });
    await invokeFrom(
      FakeBrowserWindow.instances[0].webContents,
      IPC.rdp.respondCertificate,
      sessionId,
      true,
    );

    expect(savedServer().certFingerprint).toBe('CC:33:44');
  });
});

describe('getting a server certificate again', () => {
  const check = (): Promise<RdpCertificateCheckResult> =>
    invoke<RdpCertificateCheckResult>(IPC.rdp.checkCertificate, 'server-1');

  it('shows a certificate for a server with nothing saved as new, and saves nothing', async () => {
    fakes.fetchServerCertificate.mockResolvedValue(NEW_CERTIFICATE);

    const result = await check();

    // The same route as the sessions, so a proxy from the Network settings applies to both.
    expect(fakes.fetchServerCertificate).toHaveBeenCalledWith(
      '10.0.0.5',
      3389,
      expect.objectContaining({ route: expect.any(Function) }),
    );
    const [, , deps] = fakes.fetchServerCertificate.mock.calls[0] as [
      string,
      number,
      HandshakeDeps,
    ];
    expect(fakes.proxyDeps?.route).toBe(deps.route);
    expect(result).toEqual({ ok: true, check: { certificate: NEW_CERTIFICATE, status: 'new' } });
    expect(savedServer().certFingerprint).toBeUndefined();
  });

  it('says a different certificate than the saved one is changed, and shows the saved one', async () => {
    writeServer({
      certFingerprint: OLD_CERTIFICATE.fingerprint,
      certDetails: OLD_CERTIFICATE.details,
    });
    await load();
    fakes.fetchServerCertificate.mockResolvedValue(NEW_CERTIFICATE);

    expect(await check()).toEqual({
      ok: true,
      check: { certificate: NEW_CERTIFICATE, status: 'changed', saved: OLD_CERTIFICATE },
    });
    expect(savedServer().certFingerprint).toBe('BB:99:88');
  });

  it('says the same certificate is the same', async () => {
    writeServer({
      certFingerprint: NEW_CERTIFICATE.fingerprint,
      certDetails: OLD_CERTIFICATE.details,
    });
    await load();
    fakes.fetchServerCertificate.mockResolvedValue(NEW_CERTIFICATE);

    const result = await check();

    expect(result).toMatchObject({ ok: true, check: { status: 'same' } });
  });

  it('adds the details to a certificate saved before they were kept, once it is seen again', async () => {
    writeServer({ certFingerprint: NEW_CERTIFICATE.fingerprint });
    await load();
    fakes.fetchServerCertificate.mockResolvedValue(NEW_CERTIFICATE);

    const result = await check();

    expect(result).toMatchObject({
      ok: true,
      check: { saved: { details: { subject: 'CN=WIN-NEW' } } },
    });
    await vi.waitFor(() => expect(savedServer().certDetails?.subject).toBe('CN=WIN-NEW'));
  });

  it('hands back a failure as data, so its words reach the person unchanged', async () => {
    fakes.fetchServerCertificate.mockRejectedValue(
      new RdpHandshakeError('refused', '10.0.0.5:3389 refused the connection.', 'ECONNREFUSED'),
    );

    expect(await check()).toEqual({
      ok: false,
      failure: {
        code: 'refused',
        message: '10.0.0.5:3389 refused the connection.',
        detail: 'ECONNREFUSED',
      },
    });
  });

  it('never lets the text of an unexpected error through as the sentence', async () => {
    fakes.fetchServerCertificate.mockRejectedValue(
      new Error(
        '105556096:error:1000012e:SSL routines:OPENSSL_internal:KEY_USAGE_BIT_INCORRECT:x.cc:397:',
      ),
    );

    const result = await check();

    expect(result).toEqual({
      ok: false,
      failure: {
        code: 'other',
        message: 'Could not connect to 10.0.0.5:3389.',
        detail: 'KEY_USAGE_BIT_INCORRECT (SSL routines)',
      },
    });
  });

  it('refuses a server that was removed', async () => {
    await expect(invoke(IPC.rdp.checkCertificate, 'gone')).rejects.toThrow(
      'This saved server no longer exists.',
    );
  });
});

describe('trusting a server certificate', () => {
  async function checkNew(): Promise<void> {
    fakes.fetchServerCertificate.mockResolvedValue(NEW_CERTIFICATE);
    await invoke(IPC.rdp.checkCertificate, 'server-1');
  }

  it('saves the certificate the last check showed, with its details', async () => {
    await checkNew();

    await invoke(IPC.rdp.trustCertificate, 'server-1', 'AA:11:22');

    expect(savedServer()).toMatchObject({
      certFingerprint: 'AA:11:22',
      certDetails: { subject: 'CN=WIN-NEW', issuer: 'CN=WIN-NEW' },
    });
  });

  it('replaces the old certificate of a reinstalled server', async () => {
    writeServer({ certFingerprint: OLD_CERTIFICATE.fingerprint });
    await load();
    await checkNew();

    await invoke(IPC.rdp.trustCertificate, 'server-1', 'AA:11:22');

    expect(savedServer().certFingerprint).toBe('AA:11:22');
  });

  it('refuses a fingerprint the check did not show', async () => {
    await checkNew();

    await expect(invoke(IPC.rdp.trustCertificate, 'server-1', 'FF:FF:FF')).rejects.toThrow(
      'That certificate is out of date. Get it from the server again.',
    );
    expect(savedServer().certFingerprint).toBeUndefined();
  });

  it('refuses a server that was never checked', async () => {
    await expect(invoke(IPC.rdp.trustCertificate, 'server-1', 'AA:11:22')).rejects.toThrow(
      'out of date',
    );
  });

  it('accepts a checked certificate only once', async () => {
    await checkNew();
    await invoke(IPC.rdp.trustCertificate, 'server-1', 'AA:11:22');

    await expect(invoke(IPC.rdp.trustCertificate, 'server-1', 'AA:11:22')).rejects.toThrow(
      'out of date',
    );
  });

  it('refuses a certificate checked too long ago', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await checkNew();
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await expect(invoke(IPC.rdp.trustCertificate, 'server-1', 'AA:11:22')).rejects.toThrow(
        'out of date',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('forgetting a server certificate', () => {
  it('clears the saved certificate so the next connection saves whatever the server shows', async () => {
    writeServer({
      certFingerprint: OLD_CERTIFICATE.fingerprint,
      certDetails: OLD_CERTIFICATE.details,
    });
    await load();

    await invoke(IPC.rdp.forgetCertificate, 'server-1');

    const server = savedServer();
    expect(server.certFingerprint).toBeUndefined();
    expect(server.certDetails).toBeUndefined();
    expect(server).toMatchObject({ id: 'server-1', host: '10.0.0.5', username: 'admin' });
  });

  it('also drops a certificate that was fetched but not yet trusted', async () => {
    fakes.fetchServerCertificate.mockResolvedValue(NEW_CERTIFICATE);
    await invoke(IPC.rdp.checkCertificate, 'server-1');

    await invoke(IPC.rdp.forgetCertificate, 'server-1');

    await expect(invoke(IPC.rdp.trustCertificate, 'server-1', 'AA:11:22')).rejects.toThrow(
      'out of date',
    );
  });

  it('does nothing for a server that is gone', async () => {
    await expect(invoke(IPC.rdp.forgetCertificate, 'gone')).resolves.toBeUndefined();
    expect(savedServer().id).toBe('server-1');
  });
});

describe('reordering saved servers', () => {
  const server = (id: string): StoredRdpServer => ({
    id,
    nickname: id,
    host: '10.0.0.5',
    port: 3389,
    username: 'admin',
    options: {
      resolution: 'fitWindow',
      fullscreenOnConnect: false,
      maximizeOnConnect: true,
      clipboard: true,
      fileTransfer: true,
      nla: true,
    },
    createdAt: 0,
    lastConnectedAt: null,
  });

  function storedIds(): string[] {
    return (
      JSON.parse(readFileSync(userData.dataFile('rdp-servers.json'), 'utf-8')) as StoredRdpServer[]
    ).map((one) => one.id);
  }

  beforeEach(() => {
    userData.writeData('rdp-servers.json', [
      { ...server('a'), secretEnvelope: { mode: 'safeStorage', ciphertext: 'c2VjcmV0' } },
      server('b'),
      server('c'),
    ]);
  });

  it('saves the servers in the order it is given and returns them', async () => {
    const reordered = (await invoke(IPC.rdp.reorderServers, ['c', 'a', 'b'])) as { id: string }[];

    expect(reordered.map((one) => one.id)).toEqual(['c', 'a', 'b']);
    expect(storedIds()).toEqual(['c', 'a', 'b']);
  });

  it('never hands the renderer a stored secret', async () => {
    const reordered = (await invoke(IPC.rdp.reorderServers, ['a', 'b', 'c'])) as {
      hasSecret: boolean;
    }[];

    expect(reordered[0]).toMatchObject({ hasSecret: true });
    expect(reordered[0]).not.toHaveProperty('secretEnvelope');
  });

  it('keeps a server the list leaves out, after the ones it lists', async () => {
    await invoke(IPC.rdp.reorderServers, ['b']);

    expect(storedIds()).toEqual(['b', 'a', 'c']);
  });
});

describe('editing a saved server', () => {
  const input = (patch: Record<string, unknown>) => ({
    id: 'server-1',
    nickname: 'Build box',
    host: '10.0.0.5',
    port: 3389,
    username: 'admin',
    options: { resolution: 'fitWindow' },
    ...patch,
  });

  beforeEach(async () => {
    writeServer({
      certFingerprint: OLD_CERTIFICATE.fingerprint,
      certDetails: OLD_CERTIFICATE.details,
    });
    await load();
  });

  it('keeps the saved certificate when only the nickname changes', async () => {
    await invoke(IPC.rdp.saveServer, input({ nickname: 'Renamed' }));

    expect(savedServer()).toMatchObject({
      nickname: 'Renamed',
      certFingerprint: 'BB:99:88',
      certDetails: OLD_CERTIFICATE.details,
    });
  });

  it('forgets the saved certificate when the server moves to another address', async () => {
    await invoke(IPC.rdp.saveServer, input({ host: '10.0.0.6' }));

    expect(savedServer().certFingerprint).toBeUndefined();
    expect(savedServer().certDetails).toBeUndefined();
  });

  it('forgets a certificate that was fetched for the old address', async () => {
    fakes.fetchServerCertificate.mockResolvedValue(NEW_CERTIFICATE);
    await invoke(IPC.rdp.checkCertificate, 'server-1');

    await invoke(IPC.rdp.saveServer, input({ port: 3390 }));

    await expect(invoke(IPC.rdp.trustCertificate, 'server-1', 'AA:11:22')).rejects.toThrow(
      'out of date',
    );
  });
});

describe('files copied on the server', () => {
  async function openWindow(): Promise<{
    sessionId: string;
    window: FakeBrowserWindow;
  }> {
    const sessionId = await invoke<string>(IPC.rdp.openSession, 'server-1');
    return { sessionId, window: FakeBrowserWindow.instances[0] };
  }

  /** What the session window does for each file: ask for a slot, write the bytes, finish it. */
  async function download(
    window: FakeBrowserWindow,
    downloadId: string,
    index: number,
    entry: { name: string; path?: string; isDirectory: boolean },
    contents = '',
  ): Promise<void> {
    await invokeFrom(window.webContents, IPC.rdp.prepareDownloadEntry, downloadId, index, entry);
    if (entry.isDirectory) return;
    await invokeFrom(
      window.webContents,
      IPC.rdp.writeDownloadChunk,
      downloadId,
      index,
      Buffer.from(contents),
    );
    await invokeFrom(window.webContents, IPC.rdp.finishDownloadFile, downloadId, index, true);
  }

  beforeEach(() => {
    fakes.staging = { supported: true, folder: tempDir('agentmate-staging-') };
    fakes.putFilesOnClipboard.mockReset();
    fakes.putFilesOnClipboard.mockResolvedValue(undefined);
  });

  it('puts what was downloaded on the clipboard, one entry per thing that was copied', async () => {
    const { sessionId, window } = await openWindow();

    const start = await invokeFrom<RdpStageStart>(
      window.webContents,
      IPC.rdp.beginStaging,
      sessionId,
      12,
    );
    if (!start.ok) throw new Error('staging should have started');
    await download(window, start.downloadId, 0, { name: 'photos', isDirectory: true });
    await download(
      window,
      start.downloadId,
      1,
      { name: 'a.jpg', path: 'photos', isDirectory: false },
      'jpg',
    );
    await download(window, start.downloadId, 2, { name: 'notes.txt', isDirectory: false }, 'notes');
    const result = await invokeFrom<RdpStageResult>(
      window.webContents,
      IPC.rdp.finishStaging,
      sessionId,
      start.downloadId,
    );

    expect(result).toEqual({ ok: true, count: 2, signature: 'signature-of-staged-files' });
    expect(fakes.putFilesOnClipboard).toHaveBeenCalledTimes(1);
    expect([...fakes.putFilesOnClipboard.mock.calls[0][0]].sort()).toEqual(
      [join(fakes.staging.folder, 'notes.txt'), join(fakes.staging.folder, 'photos')].sort(),
    );
    expect(existsSync(join(fakes.staging.folder, 'photos', 'a.jpg'))).toBe(true);
  });

  it('does not start when the copy is more than the clipboard should carry', async () => {
    const { sessionId, window } = await openWindow();

    const start = await invokeFrom<RdpStageStart>(
      window.webContents,
      IPC.rdp.beginStaging,
      sessionId,
      1001,
    );

    expect(start).toEqual({ ok: false, reason: 'tooLarge', limitBytes: 1000 });
  });

  it('does not start where the OS has no way to hold a file list', async () => {
    fakes.staging.supported = false;
    const { sessionId, window } = await openWindow();

    const start = await invokeFrom<RdpStageStart>(
      window.webContents,
      IPC.rdp.beginStaging,
      sessionId,
      10,
    );

    expect(start).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('reports a clipboard that would not take the files as data', async () => {
    fakes.putFilesOnClipboard.mockRejectedValue(new Error('Windows would not take them.'));
    const { sessionId, window } = await openWindow();
    const start = await invokeFrom<RdpStageStart>(
      window.webContents,
      IPC.rdp.beginStaging,
      sessionId,
      5,
    );
    if (!start.ok) throw new Error('staging should have started');
    await download(window, start.downloadId, 0, { name: 'a.txt', isDirectory: false }, 'a');

    const result = await invokeFrom<RdpStageResult>(
      window.webContents,
      IPC.rdp.finishStaging,
      sessionId,
      start.downloadId,
    );

    expect(result).toEqual({ ok: false, error: 'Windows would not take them.' });
  });

  it('has nothing to copy when no file made it to disk', async () => {
    const { sessionId, window } = await openWindow();
    const start = await invokeFrom<RdpStageStart>(
      window.webContents,
      IPC.rdp.beginStaging,
      sessionId,
      5,
    );
    if (!start.ok) throw new Error('staging should have started');
    await invokeFrom(window.webContents, IPC.rdp.prepareDownloadEntry, start.downloadId, 0, {
      name: 'half.txt',
      isDirectory: false,
    });
    await invokeFrom(window.webContents, IPC.rdp.finishDownloadFile, start.downloadId, 0, false);

    const result = await invokeFrom<RdpStageResult>(
      window.webContents,
      IPC.rdp.finishStaging,
      sessionId,
      start.downloadId,
    );

    expect(result).toEqual({ ok: false, error: 'Nothing was copied from the server.' });
    expect(fakes.putFilesOnClipboard).not.toHaveBeenCalled();
  });

  it('refuses a session that has ended', async () => {
    const { window } = await openWindow();

    await expect(
      invokeFrom(window.webContents, IPC.rdp.beginStaging, 'not-a-session', 5),
    ).rejects.toThrow('This session has ended.');
    await expect(
      invokeFrom(window.webContents, IPC.rdp.finishStaging, 'not-a-session', 'x'),
    ).rejects.toThrow('This session has ended.');
  });
});
