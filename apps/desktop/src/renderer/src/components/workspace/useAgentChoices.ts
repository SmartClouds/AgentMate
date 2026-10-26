import type { Project } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import { type AgentChoice, sortAgentChoices } from '@/lib/workspace/agentChoices';
import { projectCliId } from '@/lib/workspace/launch';
import { useCliStore } from '@/stores/cliStore';

export { type AgentChoice, orderedClis } from '@/lib/workspace/agentChoices';

export interface AgentChoices {
  /** Installed agents, in the user's order (or the project's own first when none is set). */
  installed: AgentChoice[];
  /** Agents that are not on this machine, for a gentle "install" nudge. */
  missing: AgentChoice[];
  loading: boolean;
}

/** The agent CLIs a workspace can launch, split by whether they are installed. */
export function useAgentChoices(project: Project | null): AgentChoices {
  // Re-read when the app default changes so the highlighted tile follows it.
  useCliStore((s) => s.defaultCliId);
  const cliOrder = useCliStore((s) => s.cliOrder);
  const status = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
    staleTime: 5 * 60_000,
  });
  const defaultId = project ? projectCliId(project) : null;
  const loading = status.isPending;
  return useMemo(
    () => ({ ...sortAgentChoices(status.data ?? [], cliOrder, defaultId), loading }),
    [status.data, defaultId, loading, cliOrder],
  );
}
