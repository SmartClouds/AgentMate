import { type AgentHistorySession, findGroup, type Project } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  BackgroundToggle,
  HistoryDayGroups,
  HistorySkeleton,
  HistoryToolbar,
} from '@/components/agentHistory/AgentHistoryList';
import {
  backgroundCount,
  countByProvider,
  filterSessions,
  type ProviderFilter,
} from '@/components/agentHistory/historyFilters';
import { History } from '@/components/icons';
import { queryKeys } from '@/lib/queryKeys';
import { launchResumeTab, resumedConversationId } from '@/lib/workspace/launch';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { PanelNotice } from './PanelNotice';

/**
 * Tabs already running a conversation, by the CLI's conversation id. Claude Code reports its
 * id through hooks; a tab this section resumed carries the id in its launch command.
 */
function useOpenConversations(projectId: string): Map<string, string> {
  const tabs = useWorkspaceStore((s) => s.workspaces[projectId]?.tabs);
  const runInfos = useAgentStatusStore((s) => s.runInfos);
  return useMemo(() => {
    const open = new Map<string, string>();
    for (const tab of Object.values(tabs ?? {})) {
      if (tab.kind !== 'terminal' || !tab.cliId) continue;
      const id = runInfos[tab.id]?.conversationId;
      if (id) open.set(id, tab.id);
      if (tab.conversationId && !open.has(tab.conversationId)) open.set(tab.conversationId, tab.id);
      const resumed = resumedConversationId(tab.launchInput);
      if (resumed && !open.has(resumed)) open.set(resumed, tab.id);
    }
    return open;
  }, [tabs, runInfos]);
}

/**
 * Past conversations from every supported CLI started in the project's folder. Clicking one
 * resumes it in a new tab, or jumps to the tab where it is already running.
 */
export function HistorySection({ project }: { project: Project }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<ProviderFilter>('all');
  const [showBackground, setShowBackground] = useState(false);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const openConversations = useOpenConversations(project.id);
  const history = useQuery({
    queryKey: queryKeys.agentHistory(project.id),
    queryFn: () => window.runova.agents.history(project.id),
    refetchInterval: 20_000,
    staleTime: 10_000,
    meta: { silentLoading: true },
  });

  const sessions = history.data ?? [];
  const providers = new Set(sessions.map((s) => s.provider));
  const counts = countByProvider(sessions);
  const hiddenCount = backgroundCount(sessions, provider);
  const visible = filterSessions(sessions, { query, provider, showBackground });

  function resume(session: AgentHistorySession): void {
    const openTabId = openConversations.get(session.id);
    if (openTabId) {
      activateTab(project.id, openTabId);
      return;
    }
    const ws = useWorkspaceStore.getState().workspaces[project.id];
    const group = ws ? findGroup(ws.root, ws.focusedGroupId) : null;
    launchResumeTab(project, session, group?.id);
  }

  if (history.isPending) return <HistorySkeleton rows={4} />;

  if (sessions.length === 0) {
    return (
      <PanelNotice
        icon={History}
        title="No conversations yet"
        body="Agent sessions started in this folder show up here, ready to resume."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <HistoryToolbar
        query={query}
        onQueryChange={setQuery}
        provider={provider}
        onProviderChange={setProvider}
        providers={providers}
        counts={counts}
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <HistoryDayGroups
          sessions={visible}
          openIds={openConversations}
          onResume={resume}
          showUsage
        />
        {visible.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {query.trim() || provider !== 'all'
              ? 'No conversation matches.'
              : 'Only runs started by tools so far.'}
          </p>
        ) : null}
        <BackgroundToggle
          count={hiddenCount}
          shown={showBackground}
          onToggle={() => setShowBackground((show) => !show)}
        />
      </div>
    </div>
  );
}
