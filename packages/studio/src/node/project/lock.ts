import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../fs/atomicWrite.js';

/**
 * One writer per video folder. Two copies of AgentMate (the dev and release builds, or two
 * machines on a shared drive) can point at the same storage folder, and two writers on one history
 * database is exactly how work gets lost. The lock file says who has the folder open, so the
 * second app can show "Open in another AgentMate" instead of a half-working editor. SQLite's
 * exclusive locking mode is the hard backstop behind it.
 */

export const LOCK_FILE = '.studio.lock';

const lockInfoSchema = z.object({
  appId: z.string(),
  pid: z.number().int(),
  host: z.string(),
  startedAt: z.number(),
  heartbeatAt: z.number(),
});
export type LockInfo = z.infer<typeof lockInfoSchema>;

export interface LockOptions {
  appId: string;
  pid: number;
  host: string;
  now: () => number;
  /** A holder silent for longer than this has crashed or lost the drive. */
  staleMs: number;
  /** Whether a process on this machine is still running. */
  isAlive: (pid: number) => boolean;
  /** How often to refresh the heartbeat; 0 for never (tests drive it by hand). */
  heartbeatMs: number;
  /**
   * Take a lock whose heartbeat went quiet. Off by default: the holder may only be asleep (a
   * closed laptop lid) or on another machine, so the user decides. A holder on this machine whose
   * process is gone is always taken over, since it cannot come back.
   */
  takeOverStale?: boolean;
}

export interface HeldLock {
  readonly info: LockInfo;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
  /** Stops the heartbeat without removing the file, as a crash would. Tests only. */
  abandon(): void;
}

export type LockResult =
  | { ok: true; lock: HeldLock }
  | { ok: false; holder: LockInfo; stale: boolean };

async function readLock(file: string): Promise<LockInfo | null> {
  try {
    const parsed = lockInfoSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isQuiet(holder: LockInfo, options: LockOptions): boolean {
  return options.now() - holder.heartbeatAt > options.staleMs;
}

/** The holder ran on this machine and its process is gone. A pid means nothing anywhere else. */
function isDead(holder: LockInfo, options: LockOptions): boolean {
  return holder.host === options.host && !options.isAlive(holder.pid);
}

function isSelf(holder: LockInfo, options: LockOptions): boolean {
  return (
    holder.host === options.host && holder.pid === options.pid && holder.appId === options.appId
  );
}

export async function acquireVideoLock(folder: string, options: LockOptions): Promise<LockResult> {
  const file = join(folder, LOCK_FILE);
  const info: LockInfo = {
    appId: options.appId,
    pid: options.pid,
    host: options.host,
    startedAt: options.now(),
    heartbeatAt: options.now(),
  };
  const text = () => `${JSON.stringify(info, null, 2)}\n`;
  try {
    // `wx` fails if the file exists, so two apps racing for a free folder cannot both win.
    await writeFile(file, text(), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const holder = await readLock(file);
    if (holder && !isSelf(holder, options) && !isDead(holder, options)) {
      const quiet = isQuiet(holder, options);
      if (!quiet || !options.takeOverStale) return { ok: false, holder, stale: quiet };
    }
    await writeFileAtomic(file, text());
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let released = false;
  const heartbeat = async () => {
    if (released) return;
    const current = await readLock(file);
    // Someone took the folder over (our heartbeats stopped, say, while the laptop slept). Do not
    // write over their lock.
    if (current && (current.pid !== info.pid || current.startedAt !== info.startedAt)) return;
    info.heartbeatAt = options.now();
    await writeFileAtomic(file, text());
  };
  let beating = false;
  const tick = async () => {
    // A slow disk must not stack up writes; skip a beat instead.
    if (beating) return;
    beating = true;
    try {
      await heartbeat();
    } catch {
      // The next beat tries again.
    } finally {
      beating = false;
    }
  };
  if (options.heartbeatMs > 0) {
    timer = setInterval(() => void tick(), options.heartbeatMs);
    timer.unref?.();
  }
  return {
    ok: true,
    lock: {
      info,
      heartbeat,
      abandon() {
        released = true;
        if (timer) clearInterval(timer);
      },
      async release() {
        if (released) return;
        released = true;
        if (timer) clearInterval(timer);
        const current = await readLock(file);
        if (current && current.pid === info.pid && current.startedAt === info.startedAt) {
          await rm(file, { force: true });
        }
      },
    },
  };
}
