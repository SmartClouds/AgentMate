import type {
  RdpCertificatePrompt,
  RdpProxyErrorPayload,
  RdpServerOptions,
} from '@shared/apiTypes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '@/lib/format';
import type { RdpFailure } from '@/lib/rdp/failure';
import {
  clampDesktopSize,
  cleanEngineText,
  describeConnectError,
  displayControl,
  enableCredssp,
  type FileInfo,
  forgetUnpastedUpload,
  mountRemoteDesktop,
  type RdpBackend,
  RdpFileTransferProvider,
  type RdpScale,
  type RdpSession,
  type UserInteraction,
} from '@/lib/rdp/ironRdp';
import type { RdpAgentTargets } from './useRdpAgentBridge';

export type RdpPhase =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'ended'; reason: string }
  | ({ kind: 'failed' } & RdpFailure);

export interface RdpTransfer {
  key: string;
  name: string;
  direction: 'upload' | 'download';
  transferred: number;
  total: number;
  state: 'active' | 'done' | 'failed';
  error?: string;
}

/**
 * Where the files last copied on the server are on their way to this computer's clipboard:
 * `copying` while they download, `ready` once Ctrl+V pastes them, `idle` when they aren't going
 * there (nothing copied, too large, a failure, or an OS that can't do it).
 */
export type RemoteClipboardState = 'idle' | 'copying' | 'ready';

export interface RdpNotice {
  message: string;
  tone: 'info' | 'warning';
  /** Offered next to the message, e.g. opening the folder downloads went to. */
  action?: { label: string; run: () => void };
}

const WRITE_CHUNK_BYTES = 4 * 1024 * 1024;
const RESIZE_DEBOUNCE_MS = 400;

/** Pixel size the remote desktop should have to fill `element` sharply on this display. */
function sizeFor(element: HTMLElement): { width: number; height: number; scaleFactor: number } {
  const ratio = window.devicePixelRatio || 1;
  const rect = element.getBoundingClientRect();
  return {
    ...clampDesktopSize(rect.width * ratio, rect.height * ratio),
    scaleFactor: Math.round(ratio * 100),
  };
}

/**
 * Runs one Remote Desktop connection inside `hostRef`: fetching a ticket from main, mounting
 * Devolutions' `<iron-remote-desktop>`, and wiring clipboard files and transfers on top.
 * `reconnect()` tears the element down and starts over with a fresh ticket.
 */
export function useRdpSession(sessionId: string, hostRef: React.RefObject<HTMLDivElement | null>) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<RdpPhase>({ kind: 'connecting' });
  const [nickname, setNickname] = useState('Remote Desktop');
  const [options, setOptions] = useState<RdpServerOptions | null>(null);
  const [certificate, setCertificate] = useState<RdpCertificatePrompt | null>(null);
  const [remoteFiles, setRemoteFiles] = useState<FileInfo[]>([]);
  const [remoteClipboard, setRemoteClipboard] = useState<RemoteClipboardState>('idle');
  const [transfers, setTransfers] = useState<RdpTransfer[]>([]);
  const [notice, setNotice] = useState<RdpNotice | null>(null);
  const [scale, setScaleState] = useState<RdpScale>('fit');

  const uiRef = useRef<UserInteraction | null>(null);
  const elementRef = useRef<HTMLElement | null>(null);
  const providerRef = useRef<RdpFileTransferProvider | null>(null);
  const proxyFailureRef = useRef<RdpProxyErrorPayload | null>(null);
  // Kept after the dialog closes, so "Review certificate" on the failure screen can reopen it.
  const lastCertificateRef = useRef<RdpCertificatePrompt | null>(null);
  const clipboardSignatureRef = useRef<string | null>(null);
  // Counts the server's copies, so an older one stops once a newer one arrives; the chain runs
  // them one at a time.
  const stagingGenerationRef = useRef(0);
  const stagingChainRef = useRef<Promise<void>>(Promise.resolve());
  const connectedRef = useRef(false);
  // What an AI task works through: the engine's session, the backend it came from, and the
  // canvas the remote screen is drawn on.
  const sessionRef = useRef<RdpSession | null>(null);
  const backendRef = useRef<RdpBackend | null>(null);
  const canvasRef = useRef<(() => HTMLCanvasElement | null) | null>(null);

  const upsertTransfer = useCallback((key: string, patch: Partial<RdpTransfer>) => {
    setTransfers((current) => {
      const index = current.findIndex((t) => t.key === key);
      if (index < 0) {
        const created: RdpTransfer = {
          key,
          name: patch.name ?? 'File',
          direction: patch.direction ?? 'download',
          transferred: 0,
          total: 0,
          state: 'active',
          ...patch,
        };
        return [...current, created];
      }
      const next = [...current];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }, []);

  useEffect(() => {
    const offCertificate = window.runova.rdp.onCertificatePrompt((prompt) => {
      if (prompt.sessionId !== sessionId) return;
      lastCertificateRef.current = prompt;
      setCertificate(prompt);
    });
    const offProxyError = window.runova.rdp.onProxyError((payload) => {
      if (payload.sessionId === sessionId) proxyFailureRef.current = payload;
    });
    return () => {
      offCertificate();
      offProxyError();
    };
  }, [sessionId]);

  const focusRemote = useCallback(() => {
    elementRef.current?.focus();
  }, []);

  /** Offers files copied on this computer to the server, so Ctrl+V there pastes them. */
  const syncClipboardFiles = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider || !connectedRef.current) return;
    const result = await window.runova.rdp.readClipboardFiles(
      sessionId,
      clipboardSignatureRef.current,
    );
    if (result === 'unchanged') return;
    if (!result) {
      clipboardSignatureRef.current = null;
      return;
    }
    clipboardSignatureRef.current = result.signature;
    if (result.tooLarge) {
      setNotice({
        tone: 'warning',
        message: `The files you copied add up to ${formatBytes(result.totalBytes)}, too much to paste through the clipboard. Drag them into this window instead.`,
      });
      return;
    }

    try {
      const dropped = await Promise.all(
        result.entries.map(async (entry, index) => ({
          name: entry.name,
          path: entry.path,
          size: entry.size,
          lastModified: entry.lastModified,
          isDirectory: entry.isDirectory,
          file: entry.isDirectory
            ? null
            : new File(
                [
                  (await window.runova.rdp.readClipboardFile(
                    sessionId,
                    result.signature,
                    index,
                  )) as Uint8Array<ArrayBuffer>,
                ],
                entry.name,
                { lastModified: entry.lastModified },
              ),
        })),
      );
      if (clipboardSignatureRef.current !== result.signature) return;
      forgetUnpastedUpload(provider);
      provider.uploadFiles(dropped);
    } catch (error) {
      setNotice({
        tone: 'warning',
        message: `Couldn't read the copied files: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [sessionId]);

  const uploadFiles = useCallback(
    (files: Parameters<RdpFileTransferProvider['uploadFiles']>[0]) => {
      const provider = providerRef.current;
      if (!provider || files.length === 0) return;
      forgetUnpastedUpload(provider);
      // A later clipboard copy should replace these, even if it's the same files as before.
      clipboardSignatureRef.current = null;
      provider.uploadFiles(files);
      setNotice({
        tone: 'info',
        message:
          files.length === 1
            ? 'Ready on the server. Press Ctrl+V in a folder there to paste it.'
            : `${files.length} items are ready on the server. Press Ctrl+V in a folder there to paste them.`,
      });
      focusRemote();
    },
    [focusRemote],
  );

  const pickAndSendFiles = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) return;
    uploadFiles(await provider.showFilePicker({ multiple: true }));
  }, [uploadFiles]);

  const dropFiles = useCallback(
    async (event: DragEvent) => {
      const provider = providerRef.current;
      if (!provider) return;
      event.preventDefault();
      uploadFiles(await provider.handleDrop(event));
    },
    [uploadFiles],
  );

  /**
   * Downloads `files` from the server into the folder of download `downloadId`, one by one, and
   * says how many failed. Stops early (counting nothing more) once `superseded()` is true.
   */
  const downloadInto = useCallback(
    async (
      provider: RdpFileTransferProvider,
      downloadId: string,
      files: FileInfo[],
      superseded: () => boolean = () => false,
    ): Promise<number> => {
      let failed = 0;
      for (let index = 0; index < files.length; index++) {
        if (superseded()) return failed;
        const file = files[index];
        try {
          await window.runova.rdp.prepareDownloadEntry(downloadId, index, {
            name: file.name,
            path: file.path,
            isDirectory: file.isDirectory === true,
          });
        } catch (error) {
          failed++;
          upsertTransfer(`${downloadId}:${index}`, {
            name: file.name,
            direction: 'download',
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (file.isDirectory) continue;

        const handle = provider.downloadFile(file, index);
        const key = `download:${handle.transferId}`;
        upsertTransfer(key, { name: file.name, direction: 'download', total: file.size });
        try {
          const blob = await handle.completion;
          for (let offset = 0; offset < blob.size; offset += WRITE_CHUNK_BYTES) {
            const chunk = new Uint8Array(
              await blob.slice(offset, offset + WRITE_CHUNK_BYTES).arrayBuffer(),
            );
            await window.runova.rdp.writeDownloadChunk(downloadId, index, chunk);
          }
          await window.runova.rdp.finishDownloadFile(downloadId, index, true);
          upsertTransfer(key, { state: 'done', transferred: blob.size, total: blob.size });
        } catch (error) {
          failed++;
          await window.runova.rdp
            .finishDownloadFile(downloadId, index, false)
            .catch(() => undefined);
          upsertTransfer(key, {
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return failed;
    },
    [upsertTransfer],
  );

  /**
   * Brings files just copied on the server over and onto this computer's clipboard, so Ctrl+V
   * in Explorer pastes them. Only the latest copy is worth finishing: a newer one cancels the
   * run before it, and the runs go one at a time so they never share the staging folder.
   */
  const putRemoteFilesOnClipboard = useCallback(
    (provider: RdpFileTransferProvider, files: FileInfo[]) => {
      const generation = ++stagingGenerationRef.current;
      const superseded = (): boolean =>
        stagingGenerationRef.current !== generation || providerRef.current !== provider;
      const wanted = files.length > 0;
      setRemoteClipboard(wanted ? 'copying' : 'idle');
      if (!wanted) return;

      const run = async (): Promise<void> => {
        if (superseded()) return;
        const totalBytes = files.reduce((sum, file) => sum + (file.isDirectory ? 0 : file.size), 0);
        const start = await window.runova.rdp.beginStaging(sessionId, totalBytes);
        if (superseded()) return;
        if (!start.ok) {
          setRemoteClipboard('idle');
          if (start.reason === 'tooLarge') {
            setNotice({
              tone: 'warning',
              message: `The files you copied add up to ${formatBytes(totalBytes)}, too much to put on your clipboard (up to ${formatBytes(start.limitBytes)}). Use Save files to get them.`,
            });
          }
          return;
        }

        const failed = await downloadInto(provider, start.downloadId, files, superseded);
        if (superseded()) return;
        if (failed > 0) {
          setRemoteClipboard('idle');
          setNotice({
            tone: 'warning',
            message: `Couldn't put the files you copied on your clipboard. Use Save files to get them.`,
          });
          return;
        }

        const result = await window.runova.rdp.finishStaging(sessionId, start.downloadId);
        if (superseded()) return;
        if (!result.ok) {
          setRemoteClipboard('idle');
          setNotice({ tone: 'warning', message: result.error });
          return;
        }
        // They are copied here now, so the focus sync must not offer them back to the server.
        clipboardSignatureRef.current = result.signature;
        setRemoteClipboard('ready');
      };

      stagingChainRef.current = stagingChainRef.current.then(run).catch((error: unknown) => {
        if (superseded()) return;
        setRemoteClipboard('idle');
        setNotice({
          tone: 'warning',
          message: `Couldn't put the files you copied on your clipboard: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    },
    [sessionId, downloadInto],
  );

  const saveRemoteFiles = useCallback(async () => {
    const provider = providerRef.current;
    const files = remoteFiles;
    if (!provider || files.length === 0) return;
    const target = await window.runova.rdp.beginDownload(sessionId);
    if (!target) return;

    const failed = await downloadInto(provider, target.downloadId, files);

    setNotice({
      tone: failed > 0 ? 'warning' : 'info',
      message:
        failed > 0
          ? `Saved to ${target.folder}, but ${failed} item${failed === 1 ? '' : 's'} failed.`
          : `Saved to ${target.folder}.`,
      action: {
        label: 'Open folder',
        run: () => void window.runova.rdp.openDownloadFolder(target.downloadId),
      },
    });
  }, [remoteFiles, sessionId, downloadInto]);

  // One connection attempt per `attempt`.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let ui: UserInteraction | null = null;
    let element: HTMLElement | null = null;

    setPhase({ kind: 'connecting' });
    setRemoteFiles([]);
    setRemoteClipboard('idle');
    proxyFailureRef.current = null;
    lastCertificateRef.current = null;
    clipboardSignatureRef.current = null;
    connectedRef.current = false;

    void (async () => {
      try {
        const ticket = await window.runova.rdp.getTicket(sessionId);
        if (cancelled) return;
        setNickname(ticket.nickname);
        setOptions(ticket.options);

        host.replaceChildren();
        const mounted = await mountRemoteDesktop(host, {
          onSession: (session) => {
            if (!cancelled) sessionRef.current = session;
          },
        });
        if (cancelled) {
          mounted.element.remove();
          return;
        }
        ui = mounted.ui;
        element = mounted.element;
        backendRef.current = mounted.backend;
        canvasRef.current = mounted.canvas;
        uiRef.current = ui;
        elementRef.current = element;

        ui.onWarningCallback((warning) =>
          setNotice({ tone: 'warning', message: cleanEngineText(warning) }),
        );
        // The element fixes its clipboard mode when it mounts, so this is a per-server setting
        // decided before connecting, like the clipboard box in Windows' own client. Files
        // travel over the same channel and need it on.
        ui.setEnableClipboard(ticket.options.clipboard);

        providerRef.current = null;
        if (ticket.options.clipboard && ticket.options.fileTransfer) {
          const provider = new RdpFileTransferProvider({ chunkSize: 1024 * 1024 });
          // The two packages' declarations disagree on the hook fields' visibility, though
          // this is exactly the pairing they are built for. The same object comes back.
          ui.enableFileTransfer(
            provider as unknown as Parameters<UserInteraction['enableFileTransfer']>[0],
          );
          providerRef.current = provider;
          provider.on('files-available', (files) => {
            setRemoteFiles(files);
            putRemoteFilesOnClipboard(provider, files);
          });
          provider.on('upload-batch-started', (ids, files) => {
            for (const [index, transferId] of ids) {
              const file = files[index];
              if (!file || file.isDirectory) continue;
              upsertTransfer(`upload:${transferId}`, {
                name: file.name,
                direction: 'upload',
                total: file.size,
              });
            }
          });
          provider.on('upload-progress', (progress) =>
            upsertTransfer(`upload:${progress.transferId}`, {
              transferred: progress.bytesTransferred,
              total: progress.totalBytes,
            }),
          );
          provider.on('upload-complete', (_file, _index, transferId) =>
            upsertTransfer(`upload:${transferId}`, { state: 'done' }),
          );
          provider.on('download-progress', (progress) =>
            upsertTransfer(`download:${progress.transferId}`, {
              transferred: progress.bytesTransferred,
              total: progress.totalBytes,
            }),
          );
          provider.on('error', (error) => {
            if (error.transferId == null || !error.direction) return;
            upsertTransfer(`${error.direction}:${error.transferId}`, {
              state: 'failed',
              error: error.message,
            });
          });
        }

        const fitWindow = ticket.options.resolution === 'fitWindow';
        const initial =
          ticket.options.resolution === 'fitWindow'
            ? sizeFor(host)
            : {
                ...clampDesktopSize(
                  ticket.options.resolution.width,
                  ticket.options.resolution.height,
                ),
                scaleFactor: 100,
              };

        const builder = ui
          .configBuilder()
          .withUsername(ticket.username)
          .withPassword(ticket.password)
          .withServerDomain(ticket.domain ?? '')
          .withDestination(ticket.destination)
          .withProxyAddress(ticket.proxyUrl)
          // The proxy authorizes by the one-time token in its URL; this field is unused there.
          .withAuthToken('runova')
          .withDesktopSize({ width: initial.width, height: initial.height })
          .withExtension(enableCredssp(ticket.options.nla));
        if (fitWindow) builder.withExtension(displayControl(true));

        const info = await ui.connect(builder.build());
        if (cancelled) {
          ui.shutdown();
          return;
        }
        ui.setVisibility(true);
        setScaleState('fit');
        connectedRef.current = true;
        setPhase({ kind: 'connected' });
        element.focus();
        if (fitWindow && initial.scaleFactor !== 100) {
          ui.resize(initial.width, initial.height, initial.scaleFactor);
        }
        void syncClipboardFiles();

        info
          .run()
          .then((termination) => {
            if (cancelled) return;
            connectedRef.current = false;
            sessionRef.current = null;
            setPhase({ kind: 'ended', reason: cleanEngineText(termination.reason()) });
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            connectedRef.current = false;
            sessionRef.current = null;
            setPhase({ kind: 'failed', ...describeConnectError(error, proxyFailureRef.current) });
          });
      } catch (error) {
        if (cancelled) return;
        connectedRef.current = false;
        sessionRef.current = null;
        setPhase({ kind: 'failed', ...describeConnectError(error, proxyFailureRef.current) });
      }
    })();

    return () => {
      cancelled = true;
      connectedRef.current = false;
      try {
        ui?.shutdown();
      } catch {
        // Already closed.
      }
      element?.remove();
      uiRef.current = null;
      elementRef.current = null;
      providerRef.current = null;
      sessionRef.current = null;
      backendRef.current = null;
      canvasRef.current = null;
    };
    // `attempt` is the only thing that should start a new connection.
  }, [attempt]);

  // Follow the window size when the server's resolution is set to fit it.
  useEffect(() => {
    if (phase.kind !== 'connected' || options?.resolution !== 'fitWindow') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const host = hostRef.current;
        if (!host || !uiRef.current) return;
        const next = sizeFor(host);
        uiRef.current.resize(next.width, next.height, next.scaleFactor);
      }, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, [phase.kind, options?.resolution, hostRef]);

  // Files copied elsewhere show up on the server once this window is used again, the moment
  // it regains focus, the same way the Windows client does it.
  useEffect(() => {
    const onFocus = (): void => void syncClipboardFiles();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [syncClipboardFiles]);

  // Read when a request arrives, so one object serves every connection attempt.
  const agentTargets = useMemo<RdpAgentTargets>(
    () => ({
      getSession: () => (connectedRef.current ? sessionRef.current : null),
      getBackend: () => backendRef.current,
      getCanvas: () => canvasRef.current?.() ?? null,
    }),
    [],
  );
  const getRemoteElement = useCallback(() => elementRef.current, []);

  return {
    phase,
    nickname,
    options,
    certificate,
    remoteFiles,
    remoteClipboard,
    transfers,
    notice,
    scale,
    reconnect: () => setAttempt((n) => n + 1),
    dismissNotice: () => setNotice(null),
    clearFinishedTransfers: () =>
      setTransfers((current) => current.filter((t) => t.state === 'active')),
    /** Opens the certificate prompt again after "Don't connect" closed it. */
    reviewCertificate: () => {
      if (lastCertificateRef.current) setCertificate(lastCertificateRef.current);
    },
    respondCertificate: async (trust: boolean) => {
      setCertificate(null);
      await window.runova.rdp.respondCertificate(sessionId, trust);
      if (trust) setAttempt((n) => n + 1);
    },
    setScale: (next: RdpScale) => {
      // The type only exposes a numeric enum; the component accepts these names too.
      uiRef.current?.setScale(next as unknown as Parameters<UserInteraction['setScale']>[0]);
      setScaleState(next);
      focusRemote();
    },
    ctrlAltDel: () => {
      uiRef.current?.ctrlAltDel();
      focusRemote();
    },
    focusRemote,
    agentTargets,
    getRemoteElement,
    pickAndSendFiles,
    dropFiles,
    saveRemoteFiles,
  };
}
