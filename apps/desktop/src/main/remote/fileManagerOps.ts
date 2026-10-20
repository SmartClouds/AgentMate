import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WebSocket } from 'ws';
import type { RemoteControlMessage, RemoteFileEntry } from '../../shared/remoteProtocol';
import { listLocalRoots } from '../fs/localRoots';

const REQUEST_TIMEOUT_MS = 15_000;

export interface FileManagerCallbacks {
  sendControl(ws: WebSocket, msg: RemoteControlMessage): void;
}

type Reply =
  | Extract<RemoteControlMessage, { t: 'fm-roots-reply' }>
  | Extract<RemoteControlMessage, { t: 'fm-list-reply' }>
  | Extract<RemoteControlMessage, { t: 'fm-ack' }>
  | Extract<RemoteControlMessage, { t: 'file-request-ack' }>;

interface PendingRequest {
  resolve(reply: Reply): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Request/reply half of the remote file manager: browse/mkdir/delete/rename
 * on a peer's filesystem. Each outbound method sends a `fm-*`/`file-request`
 * message tagged with a fresh `reqId` and returns a promise that resolves
 * when the matching reply arrives via `handleControl` (or rejects after
 * `REQUEST_TIMEOUT_MS`). The inbound half executes the same messages against
 * *this* machine's filesystem when the peer is the one browsing. There is
 * no path jail: a remote-control session already grants the peer OS-level
 * input on this machine, so filesystem access is not a bigger trust step.
 */
export class FileManagerOps {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly callbacks: FileManagerCallbacks) {}

  // --- Outbound: ask the peer about its filesystem ---------------------------

  roots(ws: WebSocket): Promise<RemoteFileEntry[]> {
    const reqId = randomUUID();
    return this.request(ws, { t: 'fm-roots', reqId }, reqId, (reply) => {
      if (reply.t !== 'fm-roots-reply') throw new Error('Unexpected reply.');
      return reply.roots;
    });
  }

  list(ws: WebSocket, path: string | null): Promise<{ path: string; entries: RemoteFileEntry[] }> {
    const reqId = randomUUID();
    return this.request(ws, { t: 'fm-list', reqId, path }, reqId, (reply) => {
      if (reply.t !== 'fm-list-reply') throw new Error('Unexpected reply.');
      if (reply.error) throw new Error(reply.error);
      return { path: reply.path, entries: reply.entries };
    });
  }

  mkdir(ws: WebSocket, parentPath: string, name: string): Promise<void> {
    const reqId = randomUUID();
    return this.request(ws, { t: 'fm-mkdir', reqId, parentPath, name }, reqId, ackOrThrow);
  }

  delete(ws: WebSocket, path: string): Promise<void> {
    const reqId = randomUUID();
    return this.request(ws, { t: 'fm-delete', reqId, path }, reqId, ackOrThrow);
  }

  rename(ws: WebSocket, path: string, newName: string): Promise<void> {
    const reqId = randomUUID();
    return this.request(ws, { t: 'fm-rename', reqId, path, newName }, reqId, ackOrThrow);
  }

  /** Ask the peer to push a file it has at `path` (download half of the file manager). */
  requestFile(ws: WebSocket, path: string): Promise<void> {
    const reqId = randomUUID();
    return this.request(ws, { t: 'file-request', reqId, path }, reqId, (reply) => {
      if (reply.t !== 'file-request-ack') throw new Error('Unexpected reply.');
      if (!reply.ok) throw new Error(reply.error ?? 'The peer declined.');
    });
  }

  private request<T>(
    ws: WebSocket,
    msg: RemoteControlMessage,
    reqId: string,
    extract: (reply: Reply) => T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('Timed out waiting for the peer to reply.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, {
        resolve: (reply) => {
          try {
            resolve(extract(reply));
          } catch (err) {
            reject(err as Error);
          }
        },
        reject,
        timer,
      });
      this.callbacks.sendControl(ws, msg);
    });
  }

  private resolvePending(reply: Reply): void {
    const pending = this.pending.get(reply.reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(reply.reqId);
    pending.resolve(reply);
  }

  // --- Dispatch ----------------------------------------------------------------

  handleControl(ws: WebSocket, msg: RemoteControlMessage): boolean {
    switch (msg.t) {
      case 'fm-roots-reply':
      case 'fm-list-reply':
      case 'fm-ack':
      case 'file-request-ack':
        this.resolvePending(msg);
        return true;
      case 'fm-roots':
        void this.replyRoots(ws, msg.reqId);
        return true;
      case 'fm-list':
        void this.replyList(ws, msg.reqId, msg.path);
        return true;
      case 'fm-mkdir':
        void this.replyMkdir(ws, msg.reqId, msg.parentPath, msg.name);
        return true;
      case 'fm-delete':
        void this.replyDelete(ws, msg.reqId, msg.path);
        return true;
      case 'fm-rename':
        void this.replyRename(ws, msg.reqId, msg.path, msg.newName);
        return true;
      default:
        return false;
    }
  }

  // --- Inbound: execute against our own filesystem ----------------------------

  private async replyRoots(ws: WebSocket, reqId: string): Promise<void> {
    const roots = await listRoots();
    this.callbacks.sendControl(ws, { t: 'fm-roots-reply', reqId, roots });
  }

  private async replyList(ws: WebSocket, reqId: string, path: string | null): Promise<void> {
    const target = path ?? homedir();
    try {
      const dirents = await readdir(target, { withFileTypes: true });
      const entries: RemoteFileEntry[] = await Promise.all(
        dirents.map(async (entry) => {
          const entryPath = join(target, entry.name);
          const info = entry.isDirectory() ? null : await stat(entryPath).catch(() => null);
          return {
            name: entry.name,
            path: entryPath,
            isDirectory: entry.isDirectory(),
            size: info?.size ?? 0,
            mtimeMs: info?.mtimeMs ?? 0,
          };
        }),
      );
      entries.sort(
        (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
      );
      this.callbacks.sendControl(ws, { t: 'fm-list-reply', reqId, path: target, entries });
    } catch (err) {
      this.callbacks.sendControl(ws, {
        t: 'fm-list-reply',
        reqId,
        path: target,
        entries: [],
        error: (err as Error).message,
      });
    }
  }

  private async replyMkdir(
    ws: WebSocket,
    reqId: string,
    parentPath: string,
    name: string,
  ): Promise<void> {
    try {
      await mkdir(join(parentPath, name), { recursive: false });
      this.callbacks.sendControl(ws, { t: 'fm-ack', reqId, ok: true });
    } catch (err) {
      this.callbacks.sendControl(ws, {
        t: 'fm-ack',
        reqId,
        ok: false,
        error: (err as Error).message,
      });
    }
  }

  private async replyDelete(ws: WebSocket, reqId: string, path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: false });
      this.callbacks.sendControl(ws, { t: 'fm-ack', reqId, ok: true });
    } catch (err) {
      this.callbacks.sendControl(ws, {
        t: 'fm-ack',
        reqId,
        ok: false,
        error: (err as Error).message,
      });
    }
  }

  private async replyRename(
    ws: WebSocket,
    reqId: string,
    path: string,
    newName: string,
  ): Promise<void> {
    try {
      await rename(path, join(dirname(path), newName));
      this.callbacks.sendControl(ws, { t: 'fm-ack', reqId, ok: true });
    } catch (err) {
      this.callbacks.sendControl(ws, {
        t: 'fm-ack',
        reqId,
        ok: false,
        error: (err as Error).message,
      });
    }
  }
}

function ackOrThrow(reply: Reply): void {
  if (reply.t !== 'fm-ack') throw new Error('Unexpected reply.');
  if (!reply.ok) throw new Error(reply.error ?? 'The peer rejected the request.');
}

async function listRoots(): Promise<RemoteFileEntry[]> {
  return listLocalRoots().map(({ name, path }) => ({
    name,
    path,
    isDirectory: true,
    size: 0,
    mtimeMs: 0,
  }));
}
