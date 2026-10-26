import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Backend, FakeSession } from '../../../../test/renderer/mocks/ironRdp';
import { type FakeBridge, installRunovaBridge } from '../../../../test/renderer/runovaBridge';

interface FakeFile {
  name: string;
  path?: string;
  size: number;
  lastModified: number;
  isDirectory?: boolean;
}

/**
 * Stands in for the file-transfer provider: the test plays the server by emitting events, and
 * settles each download by hand so it controls what finishes when.
 */
const mount = vi.hoisted(() => {
  class FakeProvider {
    private handlers = new Map<string, (...args: unknown[]) => void>();
    downloads: {
      file: FakeFile;
      index: number;
      resolve: (blob: Blob) => void;
      reject: (error: Error) => void;
    }[] = [];

    on(event: string, handler: (...args: unknown[]) => void): void {
      this.handlers.set(event, handler);
    }
    emit(event: string, ...args: unknown[]): void {
      this.handlers.get(event)?.(...args);
    }
    downloadFile(file: FakeFile, index: number): { transferId: number; completion: Promise<Blob> } {
      let resolve: (blob: Blob) => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      const completion = new Promise<Blob>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.downloads.push({ file, index, resolve, reject });
      return { transferId: this.downloads.length, completion };
    }
  }
  return {
    FakeProvider,
    provider: null as InstanceType<typeof FakeProvider> | null,
    /** Settles the session's `run()`, ending it. */
    endRun: null as null | ((reason: string) => void),
    session: null as unknown,
    canvas: null as HTMLCanvasElement | null,
    /** Makes the next `connect` fail the way the engine reports a failure. */
    connectError: null as unknown,
    /** Runs inside `connect`, before it settles: where the proxy's own report arrives. */
    beforeConnect: null as null | (() => void),
  };
});

vi.mock('@/lib/rdp/ironRdp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rdp/ironRdp')>();
  return {
    ...actual,
    enableCredssp: () => ({}),
    displayControl: () => ({}),
    RdpFileTransferProvider: class extends mount.FakeProvider {
      constructor() {
        super();
        mount.provider = this;
      }
    },
    mountRemoteDesktop: async (
      host: HTMLElement,
      options: { onSession?: (session: unknown) => void } = {},
    ) => {
      const element = document.createElement('div');
      host.appendChild(element);
      const builder = new Proxy(
        {},
        {
          get: (_target, key) => (key === 'build' ? () => ({}) : () => builder),
        },
      );
      const ui = {
        onWarningCallback: () => undefined,
        setEnableClipboard: () => undefined,
        enableFileTransfer: () => undefined,
        configBuilder: () => builder,
        setVisibility: () => undefined,
        shutdown: () => undefined,
        connect: async () => {
          mount.beforeConnect?.();
          if (mount.connectError) throw mount.connectError;
          // The element connects through the wrapped backend, which reports the session.
          options.onSession?.(mount.session);
          return {
            run: () =>
              new Promise((resolve) => {
                mount.endRun = (reason) => resolve({ reason: () => reason });
              }),
          };
        },
      };
      return { element, ui, backend: Backend, canvas: () => mount.canvas };
    },
  };
});

const { useRdpSession } = await import('./useRdpSession');

const ticket = {
  nickname: 'Office PC',
  username: 'me',
  password: 'pw',
  domain: null,
  destination: 'office:3389',
  proxyUrl: 'ws://127.0.0.1/x',
  options: {
    clipboard: false,
    fileTransfer: false,
    nla: true,
    resolution: { width: 1280, height: 720 },
  },
};

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installRunovaBridge({ 'rdp.getTicket': ticket });
  mount.connectError = null;
  mount.beforeConnect = null;
  mount.session = new FakeSession();
  mount.canvas = document.createElement('canvas');
  mount.endRun = null;
  mount.provider = null;
});

function renderSession() {
  const host = document.createElement('div');
  return renderHook(() => useRdpSession('s1', { current: host }));
}

describe('useRdpSession agent targets', () => {
  it('hands out the session, backend and canvas once connected', async () => {
    const { result } = renderSession();
    expect(result.current.agentTargets.getSession()).toBeNull();

    await waitFor(() => expect(result.current.phase.kind).toBe('connected'));
    expect(result.current.agentTargets.getSession()).toBe(mount.session);
    expect(result.current.agentTargets.getBackend()).toBe(Backend);
    expect(result.current.agentTargets.getCanvas()).toBe(mount.canvas);
    expect(result.current.getRemoteElement()).toBeInstanceOf(HTMLElement);
  });

  it('drops the session when the connection ends', async () => {
    const { result } = renderSession();
    await waitFor(() => expect(result.current.phase.kind).toBe('connected'));

    await act(async () => mount.endRun?.('Logged off'));
    await waitFor(() => expect(result.current.phase.kind).toBe('ended'));
    expect(result.current.agentTargets.getSession()).toBeNull();
  });

  it('keeps the same targets object across renders', async () => {
    const { result } = renderSession();
    const first = result.current.agentTargets;
    await waitFor(() => expect(result.current.phase.kind).toBe('connected'));
    expect(result.current.agentTargets).toBe(first);
  });
});

/** What the engine throws when the RDCleanPath handshake with the proxy fails. */
const rdCleanPathError = {
  kind: () => 4,
  backtrace: () => '',
  rdcleanpathDetails: () => undefined,
};

const keyUsageReport = {
  sessionId: 's1',
  code: 'tls-key-usage',
  message: "The certificate office:3389 presented can't be used to set up an encrypted connection.",
  detail: 'KEY_USAGE_BIT_INCORRECT (SSL routines)',
};

const prompt = {
  sessionId: 's1',
  host: 'office',
  expectedFingerprint: 'OLD',
  actualFingerprint: 'NEW',
  subject: 'CN=office',
  issuer: 'CN=office',
  validTo: 'Jan 1 2027',
};

describe('useRdpSession when the connection fails', () => {
  it('explains a failed secure connection with what the proxy reported', async () => {
    mount.connectError = rdCleanPathError;
    mount.beforeConnect = () => bridge.$emit('rdp.onProxyError', keyUsageReport);

    const { result } = renderSession();
    await waitFor(() => expect(result.current.phase.kind).toBe('failed'));

    expect(result.current.phase).toMatchObject({
      kind: 'failed',
      code: 'tls-key-usage',
      title: "The server's certificate can't be used",
      message: keyUsageReport.message,
      detail: 'KEY_USAGE_BIT_INCORRECT (SSL routines)',
    });
  });

  it('ignores what the proxy reports for another session', async () => {
    mount.connectError = rdCleanPathError;
    mount.beforeConnect = () =>
      bridge.$emit('rdp.onProxyError', { ...keyUsageReport, sessionId: 'someone-else' });

    const { result } = renderSession();
    await waitFor(() => expect(result.current.phase.kind).toBe('failed'));

    expect(result.current.phase).toMatchObject({
      code: 'other',
      message: 'Could not reach the server.',
    });
  });

  it('forgets the last failure when it tries again', async () => {
    mount.connectError = rdCleanPathError;
    mount.beforeConnect = () => bridge.$emit('rdp.onProxyError', keyUsageReport);
    const { result } = renderSession();
    await waitFor(() => expect(result.current.phase.kind).toBe('failed'));

    mount.connectError = null;
    mount.beforeConnect = null;
    act(() => result.current.reconnect());

    await waitFor(() => expect(result.current.phase.kind).toBe('connected'));
  });

  it('lets the certificate prompt be reopened after saying no to it', async () => {
    mount.connectError = rdCleanPathError;
    mount.beforeConnect = () => {
      bridge.$emit('rdp.onCertificatePrompt', prompt);
      bridge.$emit('rdp.onProxyError', {
        sessionId: 's1',
        code: 'certificate-changed',
        message: 'office is presenting a different certificate than the one Runova saved.',
      });
    };
    const { result } = renderSession();
    await waitFor(() => expect(result.current.certificate).toEqual(prompt));
    await waitFor(() => expect(result.current.phase.kind).toBe('failed'));
    expect(result.current.phase).toMatchObject({ code: 'certificate-changed' });

    await act(() => result.current.respondCertificate(false));
    expect(result.current.certificate).toBeNull();
    expect(bridge.$fn('rdp.respondCertificate')).toHaveBeenCalledWith('s1', false);

    act(() => result.current.reviewCertificate());
    expect(result.current.certificate).toEqual(prompt);
  });

  it('has nothing to reopen when no certificate was asked about', async () => {
    const { result } = renderSession();
    await waitFor(() => expect(result.current.phase.kind).toBe('connected'));

    act(() => result.current.reviewCertificate());

    expect(result.current.certificate).toBeNull();
  });

  it('connects again with a fresh ticket once the new certificate is trusted', async () => {
    mount.connectError = rdCleanPathError;
    mount.beforeConnect = () => bridge.$emit('rdp.onCertificatePrompt', prompt);
    const { result } = renderSession();
    await waitFor(() => expect(result.current.certificate).toEqual(prompt));

    mount.connectError = null;
    mount.beforeConnect = null;
    await act(() => result.current.respondCertificate(true));

    await waitFor(() => expect(result.current.phase.kind).toBe('connected'));
    expect(bridge.$fn('rdp.respondCertificate')).toHaveBeenCalledWith('s1', true);
    expect(bridge.$fn('rdp.getTicket')).toHaveBeenCalledTimes(2);
  });
});

describe('useRdpSession files copied on the server', () => {
  const MB = 1024 * 1024;
  const report: FakeFile = { name: 'report.pdf', size: 5, lastModified: 0 };
  const notes: FakeFile = { name: 'notes.txt', size: 5, lastModified: 0 };

  function connectWithFileTransfer(overrides: Record<string, unknown> = {}) {
    let staged = 0;
    bridge = installRunovaBridge({
      'rdp.getTicket': {
        ...ticket,
        options: { ...ticket.options, clipboard: true, fileTransfer: true },
      },
      'rdp.beginStaging': async () => ({ ok: true, downloadId: `stage-${++staged}` }),
      'rdp.finishStaging': { ok: true, count: 1, signature: 'staged-signature' },
      ...overrides,
    });
    return renderSession();
  }

  async function connected(result: { current: ReturnType<typeof useRdpSession> }) {
    await waitFor(() => expect(result.current.phase.kind).toBe('connected'));
    expect(mount.provider).not.toBeNull();
  }

  /** The server copies files: the provider reports them. */
  function serverCopies(...files: FakeFile[]) {
    act(() => mount.provider?.emit('files-available', files));
  }

  /** The server hands over one file's bytes. */
  async function finishDownload(position: number, contents: string) {
    await act(async () => mount.provider?.downloads[position].resolve(new Blob([contents])));
  }

  it('puts them on the clipboard once they are downloaded', async () => {
    const { result } = connectWithFileTransfer();
    await connected(result);

    serverCopies(report);
    expect(result.current.remoteClipboard).toBe('copying');
    await waitFor(() => expect(mount.provider?.downloads).toHaveLength(1));
    await finishDownload(0, 'hello');

    await waitFor(() => expect(result.current.remoteClipboard).toBe('ready'));
    expect(bridge.$fn('rdp.beginStaging')).toHaveBeenCalledWith('s1', 5);
    expect(bridge.$fn('rdp.prepareDownloadEntry')).toHaveBeenCalledWith('stage-1', 0, {
      name: 'report.pdf',
      path: undefined,
      isDirectory: false,
    });
    expect(bridge.$fn('rdp.writeDownloadChunk')).toHaveBeenCalledWith(
      'stage-1',
      0,
      expect.any(Uint8Array),
    );
    expect(bridge.$fn('rdp.finishStaging')).toHaveBeenCalledWith('s1', 'stage-1');
    expect(result.current.notice).toBeNull();
    // The Save files button still has them.
    expect(result.current.remoteFiles).toEqual([report]);
  });

  it('does not offer those files back to the server when the window is focused again', async () => {
    const { result } = connectWithFileTransfer();
    await connected(result);
    serverCopies(report);
    await waitFor(() => expect(mount.provider?.downloads).toHaveLength(1));
    await finishDownload(0, 'hello');
    await waitFor(() => expect(result.current.remoteClipboard).toBe('ready'));

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() =>
      expect(bridge.$fn('rdp.readClipboardFiles')).toHaveBeenLastCalledWith(
        's1',
        'staged-signature',
      ),
    );
  });

  it('counts only files, not the folders around them, towards the size', async () => {
    const { result } = connectWithFileTransfer();
    await connected(result);

    serverCopies(
      { name: 'photos', size: 0, lastModified: 0, isDirectory: true },
      { name: 'a.jpg', path: 'photos', size: 7, lastModified: 0 },
      { name: 'b.jpg', path: 'photos', size: 3, lastModified: 0 },
    );

    await waitFor(() => expect(bridge.$fn('rdp.beginStaging')).toHaveBeenCalledWith('s1', 10));
  });

  it('says so, and downloads nothing, when the copy is more than the clipboard should carry', async () => {
    const { result } = connectWithFileTransfer({
      'rdp.beginStaging': { ok: false, reason: 'tooLarge', limitBytes: 256 * MB },
    });
    await connected(result);

    serverCopies({ name: 'movie.mkv', size: 900 * MB, lastModified: 0 });

    await waitFor(() => expect(result.current.notice?.tone).toBe('warning'));
    expect(result.current.notice?.message).toMatch(/too much to put on your clipboard/);
    expect(result.current.notice?.message).toMatch(/Save files/);
    expect(result.current.remoteClipboard).toBe('idle');
    expect(mount.provider?.downloads).toEqual([]);
    expect(() => bridge.$fn('rdp.finishStaging')).toThrow('has not been touched');
  });

  it('stays quiet where the system cannot put files on the clipboard', async () => {
    const { result } = connectWithFileTransfer({
      'rdp.beginStaging': { ok: false, reason: 'unsupported' },
    });
    await connected(result);

    serverCopies(report);

    await waitFor(() => expect(bridge.$fn('rdp.beginStaging')).toHaveBeenCalled());
    await waitFor(() => expect(result.current.remoteClipboard).toBe('idle'));
    expect(result.current.notice).toBeNull();
    expect(mount.provider?.downloads).toEqual([]);
    expect(result.current.remoteFiles).toEqual([report]);
  });

  it('points to Save files when a download fails', async () => {
    const { result } = connectWithFileTransfer();
    await connected(result);
    serverCopies(report);
    await waitFor(() => expect(mount.provider?.downloads).toHaveLength(1));

    await act(async () => mount.provider?.downloads[0].reject(new Error('lock expired')));

    await waitFor(() => expect(result.current.notice?.tone).toBe('warning'));
    expect(result.current.notice?.message).toMatch(/Use Save files/);
    expect(result.current.remoteClipboard).toBe('idle');
    expect(() => bridge.$fn('rdp.finishStaging')).toThrow('has not been touched');
  });

  it('shows what Windows said when it would not take the files', async () => {
    const refusal = 'Windows would not take the files onto the clipboard. Try again.';
    const { result } = connectWithFileTransfer({
      'rdp.finishStaging': { ok: false, error: refusal },
    });
    await connected(result);
    serverCopies(report);
    await waitFor(() => expect(mount.provider?.downloads).toHaveLength(1));
    await finishDownload(0, 'hello');

    await waitFor(() => expect(result.current.notice?.message).toBe(refusal));
    expect(result.current.remoteClipboard).toBe('idle');
  });

  it('finishes only the latest copy when a newer one arrives mid-download', async () => {
    const { result } = connectWithFileTransfer();
    await connected(result);
    serverCopies(report);
    await waitFor(() => expect(mount.provider?.downloads).toHaveLength(1));

    serverCopies(notes);
    await finishDownload(0, 'older');
    await waitFor(() => expect(mount.provider?.downloads).toHaveLength(2));
    expect(mount.provider?.downloads[1].file.name).toBe('notes.txt');
    await finishDownload(1, 'newer');

    await waitFor(() => expect(result.current.remoteClipboard).toBe('ready'));
    expect(bridge.$fn('rdp.finishStaging')).toHaveBeenCalledTimes(1);
    expect(bridge.$fn('rdp.finishStaging')).toHaveBeenCalledWith('s1', 'stage-2');
  });

  it('drops back to idle when the server copies nothing', async () => {
    const { result } = connectWithFileTransfer();
    await connected(result);
    serverCopies(report);
    await waitFor(() => expect(mount.provider?.downloads).toHaveLength(1));
    await finishDownload(0, 'hello');
    await waitFor(() => expect(result.current.remoteClipboard).toBe('ready'));

    serverCopies();

    expect(result.current.remoteClipboard).toBe('idle');
    expect(bridge.$fn('rdp.beginStaging')).toHaveBeenCalledTimes(1);
  });

  it('still saves to the folder the person picks', async () => {
    const folder = 'D:\\Saved';
    const { result } = connectWithFileTransfer({
      'rdp.beginStaging': { ok: false, reason: 'unsupported' },
      'rdp.beginDownload': { downloadId: 'save-1', folder },
    });
    await connected(result);
    serverCopies(report);
    await waitFor(() => expect(result.current.remoteFiles).toEqual([report]));

    let saving: Promise<void> | undefined;
    act(() => {
      saving = result.current.saveRemoteFiles();
    });
    await waitFor(() => expect(mount.provider?.downloads).toHaveLength(1));
    await finishDownload(0, 'hello');
    await act(async () => saving);

    expect(bridge.$fn('rdp.prepareDownloadEntry')).toHaveBeenCalledWith('save-1', 0, {
      name: 'report.pdf',
      path: undefined,
      isDirectory: false,
    });
    expect(bridge.$fn('rdp.finishDownloadFile')).toHaveBeenCalledWith('save-1', 0, true);
    expect(result.current.notice?.message).toBe(`Saved to ${folder}.`);
  });
});
