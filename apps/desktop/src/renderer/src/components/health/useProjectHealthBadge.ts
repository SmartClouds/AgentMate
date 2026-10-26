import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { SectionBadge } from '@/components/projects/ProjectDetailChrome';
import { queryKeys } from '@/lib/queryKeys';
import { openIncidentCount } from './healthView';
import { useHealthChanges } from './useHealth';

/** The Health tab's badge on a project page: how many of its targets have an incident open. */
export function useProjectHealthBadge(projectId: string | undefined): SectionBadge | undefined {
  useHealthChanges();
  const query = useQuery({
    queryKey: queryKeys.healthList(projectId ?? ''),
    queryFn: async () => (await window.runova.health.list({ projectId: projectId ?? '' })) ?? [],
    enabled: Boolean(projectId),
    meta: { silentLoading: true },
  });
  const open = openIncidentCount(query.data?.filter((one) => one.projectId === projectId));
  return useMemo(() => (open > 0 ? { count: open, attention: true } : undefined), [open]);
}
