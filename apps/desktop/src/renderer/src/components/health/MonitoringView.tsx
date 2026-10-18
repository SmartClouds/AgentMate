import { useSearchParams } from 'react-router-dom';
import { Bug, HeartPulse } from '@/components/icons';
import { PillTabs } from '@/components/pageKit';
import { ErrorsBoard } from '../errorTracking/ErrorsBoard';
import { DEFAULT_PERIOD, DEFAULT_SORT, DEFAULT_STATUS } from '../errorTracking/errorView';
import {
  issueFilter,
  useErrorConnections,
  useErrorIssues,
  useErrorLinks,
} from '../errorTracking/useErrorTracking';
import { HealthBoard } from './HealthBoard';

/**
 * Monitoring's two views: Uptime (the health checks, E22) and Errors (what Sentry recorded,
 * E24). The view lives in `?view=errors`, not `?tab=`, which a project page owns, so a `?target=`
 * link from a notification still lands on Uptime. The Errors tab counts the unresolved issues,
 * read through the same query the list starts with, so the count costs no extra call.
 */

type MonitoringTab = 'uptime' | 'errors';

function useUnresolvedCount(projectId: string | undefined): number | undefined {
  const connections = useErrorConnections();
  const hasConnection = (connections.data ?? []).length > 0;
  const links = useErrorLinks(projectId, hasConnection);
  const linked = (links.data ?? []).some((one) => !projectId || one.projectId === projectId);
  const issues = useErrorIssues(
    issueFilter({ projectId, status: DEFAULT_STATUS, period: DEFAULT_PERIOD, sort: DEFAULT_SORT }),
    { enabled: linked, poll: false },
  );
  return linked && issues.loaded && !issues.isPlaceholder ? issues.issues.length : undefined;
}

export function MonitoringView({ projectId }: { projectId?: string }): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const view: MonitoringTab = searchParams.get('view') === 'errors' ? 'errors' : 'uptime';
  const unresolved = useUnresolvedCount(projectId);

  function show(next: MonitoringTab): void {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === 'errors') {
        params.set('view', 'errors');
        params.delete('target');
      } else {
        params.delete('view');
        params.delete('issue');
      }
      return params;
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <PillTabs
        id={`monitoring-view-${projectId ?? 'all'}`}
        label="Monitoring view"
        value={view}
        onChange={show}
        className="self-start"
        items={[
          { value: 'uptime', label: 'Uptime', icon: <HeartPulse /> },
          { value: 'errors', label: 'Errors', icon: <Bug />, count: unresolved },
        ]}
      />
      {view === 'errors' ? (
        <ErrorsBoard key={projectId ?? 'all'} projectId={projectId} />
      ) : (
        <HealthBoard key={projectId ?? 'all'} projectId={projectId} />
      )}
    </div>
  );
}
