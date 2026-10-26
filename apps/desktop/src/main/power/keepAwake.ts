import type { KeepAwakeMode } from '@runova/core';
import { powerSaveBlocker } from 'electron';
import type { KeepAwakeStatus } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';

/**
 * Whether this machine is allowed to fall asleep. Windows also throttles a backgrounded app
 * ("efficiency mode"), which can starve a shell running in a tab, so the same blocker that
 * keeps the machine awake keeps the app running at full speed while work is in flight.
 *
 * `prevent-app-suspension` lets the screen turn off; only sleep is held back.
 */
let mode: KeepAwakeMode = 'agent';
/** What is busy right now, e.g. an agent producing output or an open SSH session. */
const busy = new Set<string>();
let blockerId: number | null = null;

function shouldBlock(): boolean {
  if (mode === 'off') return false;
  return mode === 'on' || busy.size > 0;
}

function apply(): void {
  const wanted = shouldBlock();
  const blocking = blockerId != null && powerSaveBlocker.isStarted(blockerId);
  if (wanted && !blocking) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!wanted && blockerId != null) {
    if (blocking) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  } else {
    return;
  }
  const payload = keepAwake.status();
  broadcastToWindows(IPC.power.onKeepAwake, payload);
}

export const keepAwake = {
  setMode(next: KeepAwakeMode): void {
    if (next === mode) return;
    mode = next;
    apply();
  },

  /** Marks a kind of work as running or finished, e.g. `setBusy('agents', true)`. */
  setBusy(reason: string, running: boolean): void {
    const had = busy.has(reason);
    if (running === had) return;
    if (running) busy.add(reason);
    else busy.delete(reason);
    apply();
  },

  status(): KeepAwakeStatus {
    return { mode, blocking: blockerId != null, busy: [...busy] };
  },
};
