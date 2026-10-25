import { useNavigate } from 'react-router-dom';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useTerminalStore } from '@/stores/terminalStore';
import { PanelNotice } from './PanelNotice';
import type { PipelineNotice } from './usePipelineStatus';

/**
 * What the Pipelines section (and its larger view) shows in place of rows: gh missing, signed out,
 * no GitHub remote, no workflows, or a failed read with a way to retry.
 */
export function PipelinesNotice({
  notice,
  retrying,
  onRetry,
  onLeave,
}: {
  notice: PipelineNotice;
  retrying: boolean;
  onRetry: () => void;
  /** Called before an action takes the user somewhere else, so a dialog can close first. */
  onLeave?: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const openSession = useTerminalStore((s) => s.openSession);

  switch (notice.kind) {
    case 'no-cli':
      return (
        <PanelNotice
          title="GitHub CLI not found"
          body="Install gh to see workflow runs here."
          action={{
            label: 'Open Agent Tools',
            run: () => {
              onLeave?.();
              navigate('/tools');
            },
          }}
        />
      );
    case 'signed-out':
      return (
        <PanelNotice
          title="Sign in to GitHub"
          body="gh needs to be signed in to read workflow runs."
          action={{
            label: 'Run gh auth login',
            run: () => {
              onLeave?.();
              openSession({ title: 'GitHub sign in', initialInput: 'gh auth login' });
            },
          }}
        />
      );
    case 'no-remote':
      return (
        <PanelNotice title="No GitHub remote" body="This repository is not hosted on GitHub." />
      );
    case 'no-workflows':
      return (
        <PanelNotice title="No workflows yet" body={`${notice.repo} has no GitHub Actions.`} />
      );
    case 'error':
      return (
        <PanelNotice
          title="Could not load pipelines"
          body={
            notice.error ? (
              <SimpleTooltip label={notice.error} className="max-w-sm" wrapTrigger>
                <span className="cursor-help underline decoration-dotted underline-offset-4">
                  Could not connect to GitHub.
                </span>
              </SimpleTooltip>
            ) : (
              'Try again in a moment.'
            )
          }
          action={{
            label: 'Retry',
            run: onRetry,
            pending: retrying,
            pendingLabel: 'Retrying…',
          }}
        />
      );
  }
}
