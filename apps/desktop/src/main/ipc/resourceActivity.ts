import type { ResourceActivitySnapshot, ResourceRef, ResourceStopOutcome } from '@runova/core';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { getResourceActivityTracker } from '../resourceActivity/runtime';

/** More than this is a bug in the caller, not a big machine: the list shows a handful. */
const MAX_REFS = 50;
const MAX_ID_LENGTH = 200;

function isRef(value: unknown): value is ResourceRef {
  if (!value || typeof value !== 'object') return false;
  const { kind, id } = value as Record<string, unknown>;
  return (
    (kind === 'docker' || kind === 'emulator') &&
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_ID_LENGTH
  );
}

export function registerResourceActivityHandlers(): void {
  ipcMain.handle(
    IPC.resourceActivity.snapshot,
    (_event, options?: { fresh?: boolean }): Promise<ResourceActivitySnapshot> =>
      getResourceActivityTracker().snapshot({ fresh: options?.fresh === true }),
  );

  ipcMain.handle(
    IPC.resourceActivity.stop,
    (_event, refs: unknown, options?: { onlyIfIdle?: boolean }): Promise<ResourceStopOutcome> => {
      if (!Array.isArray(refs) || refs.length > MAX_REFS || !refs.every(isRef)) {
        throw new Error('Invalid resources to stop.');
      }
      // Rebuilt from the two checked fields, so nothing else a caller attached gets through.
      const clean = refs.map((ref): ResourceRef => ({ kind: ref.kind, id: ref.id }));
      return getResourceActivityTracker().stop(clean, { onlyIfIdle: options?.onlyIfIdle === true });
    },
  );
}
