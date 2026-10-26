import type { AndroidEvent } from '@runova/core';
import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';

/**
 * One place the Android feature talks back to the renderer from. Device state, boot progress and
 * usage all ride one channel, so the renderer has a single subscription to manage.
 */

export function emitAndroidEvent(event: AndroidEvent): void {
  broadcastToWindows(IPC.android.onEvent, event);
}
