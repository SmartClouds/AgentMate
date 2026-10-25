import {
  type DevDetection,
  type DevItemId,
  type DevJobState,
  type DevSetupEnvironment,
  type DevUpdateCheck,
  isDevItemId,
} from '@agentmat/core';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { getDevSetupService } from '../devSetup/runtime';
import type { UserPathResult } from '../devSetup/userPath';

/**
 * The renderer sends item ids and nothing else. An id is only a key into the catalog in
 * @agentmat/core, and everything that follows (which command is probed, which file is read, what
 * is installed) comes from that entry, so the one thing to get right here is refusing ids that are
 * not in it. No command line ever crosses this boundary.
 */

/** More ids than the catalog has items is a bug in the caller, not a big machine. */
const MAX_IDS = 60;

/** A clean, de-duplicated list of catalog ids, or a refusal. */
function checkedIds(ids: unknown): DevItemId[] {
  // The length check comes first so a long list of one repeated id cannot slip under it.
  if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every(isDevItemId)) {
    throw new Error('Invalid dev setup items.');
  }
  return [...new Set<DevItemId>(ids)];
}

export function registerDevSetupHandlers(): void {
  ipcMain.handle(
    IPC.devSetup.environment,
    (_event, options?: { force?: boolean }): Promise<DevSetupEnvironment> =>
      getDevSetupService().environment({ force: options?.force === true }),
  );

  ipcMain.handle(
    IPC.devSetup.detect,
    (_event, id: unknown, options?: { force?: boolean }): Promise<DevDetection> => {
      if (!isDevItemId(id)) throw new Error('Unknown dev setup item.');
      return getDevSetupService().detect(id, { force: options?.force === true });
    },
  );

  ipcMain.handle(
    IPC.devSetup.peek,
    (_event, ids: unknown): Record<DevItemId, DevDetection | undefined> =>
      getDevSetupService().peek(checkedIds(ids)),
  );

  ipcMain.handle(
    IPC.devSetup.updates,
    (
      _event,
      ids: unknown,
      options?: { force?: boolean },
    ): Promise<Record<DevItemId, DevUpdateCheck>> =>
      getDevSetupService().updates(checkedIds(ids), { force: options?.force === true }),
  );

  ipcMain.handle(IPC.devSetup.install, (_event, request: unknown): Promise<DevJobState> => {
    const { ids, consented, intent } = (request ?? {}) as {
      ids?: unknown;
      consented?: unknown;
      intent?: unknown;
    };
    // Rebuilt from the checked fields, so nothing else a caller attached gets through. The intent
    // is one of two words, never anything that reaches a command.
    return getDevSetupService().install({
      ids: checkedIds(ids),
      consented: consented === true,
      ...(intent === 'update' ? { intent: 'update' as const } : {}),
    });
  });

  ipcMain.handle(IPC.devSetup.cancel, (_event, id?: unknown): void => {
    if (id !== undefined && !isDevItemId(id)) throw new Error('Unknown dev setup item.');
    getDevSetupService().cancel(id);
  });

  ipcMain.handle(IPC.devSetup.addToPath, (_event, id: unknown): Promise<UserPathResult> => {
    // Only the id crosses over. Which folder goes on the PATH is worked out in main from where the
    // tool was found, never taken from the caller.
    if (!isDevItemId(id)) throw new Error('Unknown dev setup item.');
    return getDevSetupService().addToPath(id);
  });

  ipcMain.handle(IPC.devSetup.jobState, (): DevJobState => getDevSetupService().jobState());
}
