import {
  describeOpenSessions,
  QUIT_CONFIRM_LABEL,
  QUIT_CONFIRM_TITLE,
} from '@shared/quitConfirmation';
import { useEffect } from 'react';
import { confirmDialog } from '@/stores/confirmStore';

/**
 * Answers main when the app is being closed while CLIs, SSH connections or Remote Desktop
 * sessions are still open. Renders nothing; the question goes through the shared confirm modal.
 */
export function QuitConfirmation(): null {
  useEffect(
    () =>
      window.runova.app.onConfirmQuit((summary) => {
        void confirmDialog({
          title: QUIT_CONFIRM_TITLE,
          description: describeOpenSessions(summary),
          confirmLabel: QUIT_CONFIRM_LABEL,
          variant: 'destructive',
        }).then((confirmed) => window.runova.app.answerQuit(confirmed));
      }),
    [],
  );
  return null;
}
