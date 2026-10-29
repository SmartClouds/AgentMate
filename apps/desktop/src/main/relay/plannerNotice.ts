import { IPC } from '../../shared/ipcChannels';
import type { RelayPlannerResult } from '../../shared/relayTypes';
import { broadcastToWindows } from '../ipc/send';
import { focusMainWindow, getMainWindow } from '../mainWindow';
import { showOsNotification } from '../notifications/osNotification';
import { findProjectScope } from '../worktrees/resolve';

export type PlannerKind = 'split' | 'revise' | 'catch-up';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

const READY_TITLE: Record<PlannerKind, string> = {
  split: 'Tasks are ready to review',
  revise: 'Board review is ready',
  'catch-up': 'The rest of the project is planned',
};

/**
 * Planning runs in the background, so the user may be in another app by the time it ends. When the
 * window is not focused, an OS notification says so, and clicking it brings the app forward and
 * asks the renderer to reopen the plan. A focused window gets an in-app toast from the renderer
 * instead, which knows whether the dialog is already on screen.
 */
export async function announcePlannerResult(
  kind: PlannerKind,
  input: { requestId: string; projectId: string },
  result: RelayPlannerResult,
): Promise<void> {
  if (!result.ok && result.cancelled) return;
  if (getMainWindow()?.isFocused()) return;
  const project = await findProjectScope(input.projectId).catch(() => null);
  const where = project?.name ?? 'Relay';
  const title = result.ok ? READY_TITLE[kind] : 'Planning stopped';
  const body = result.ok
    ? `${where}: ${
        kind === 'split'
          ? plural(result.proposal.add.length, 'task')
          : plural(result.entries.length, 'change')
      } to look over.`
    : `${where}: ${result.error}`;
  showOsNotification({
    title,
    body,
    route: '',
    onClick: () => {
      focusMainWindow();
      broadcastToWindows(IPC.relay.onPlannerOpen, input.requestId);
    },
  });
}
