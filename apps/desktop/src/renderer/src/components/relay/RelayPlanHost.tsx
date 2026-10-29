import { useEffect } from 'react';
import { useRelayPlanDialogStore } from '@/stores/relayPlanDialogStore';
import { findPlanJobByRequestId, openPlanJob } from '@/stores/relayPlanJobsStore';
import { ReviseWithAiDialog } from './ReviseWithAiDialog';
import { SplitIntoTasksDialog } from './SplitIntoTasksDialog';

/**
 * The Relay planning dialogs, mounted once in the app like the board. Pages open them through
 * the dialog store, and a plan that finished in the background reopens here from a toast, the
 * status bar or a click on its OS notification.
 */
export function RelayPlanHost(): React.JSX.Element | null {
  const request = useRelayPlanDialogStore((s) => s.request);
  const open = useRelayPlanDialogStore((s) => s.open);
  const close = useRelayPlanDialogStore((s) => s.close);

  useEffect(
    () =>
      window.runova.relay.onPlannerOpen((requestId) => {
        const job = findPlanJobByRequestId(requestId);
        if (job) openPlanJob(job.key);
      }),
    [],
  );

  if (!request) return null;
  const onOpenChange = (next: boolean) => {
    if (!next) close();
  };

  if (request.kind === 'split') {
    return (
      <SplitIntoTasksDialog
        open={open}
        onOpenChange={onOpenChange}
        request={request.request ?? ''}
        projectId={request.projectId}
        defaultProjectId={request.defaultProjectId ?? null}
      />
    );
  }
  if (!request.projectId) return null;
  return (
    <ReviseWithAiDialog
      // A different mode or project is a different form, not this one with new props.
      key={`${request.kind}:${request.projectId}`}
      projectId={request.projectId}
      mode={request.kind}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
