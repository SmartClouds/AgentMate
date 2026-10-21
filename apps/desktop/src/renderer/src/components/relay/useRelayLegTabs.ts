import { useEffect } from 'react';
import { useWorkspaceStore } from '@/stores/workspaceStore';

/**
 * Shows each Relay leg as a tab of its project's workspace. Main starts the leg's session itself,
 * so a leg runs even for a project nobody is looking at; the tab only attaches to it. Mounted
 * once, in the workspace host, which lives as long as the window.
 */
export function useRelayLegTabs(): void {
  useEffect(() => {
    const relay = window.agentmat.relay;
    const offLeg = relay.onLegTab((event) => {
      useWorkspaceStore.getState().addRelayLegTab(event.projectId, {
        id: event.tabId,
        title: event.title,
        cliId: event.cliId,
        cwd: event.cwd,
        runLabel: event.runLabel,
        relayLegId: event.legId,
      });
    });
    const offClose = relay.onCloseTab((event) => {
      const store = useWorkspaceStore.getState();
      if (store.workspaces[event.projectId]?.tabs[event.tabId]) {
        store.closeTab(event.projectId, event.tabId);
      }
    });

    // After a reload, tell main which legs already have a tab, so none is launched twice.
    const tabs: { legId: string; tabId: string }[] = [];
    for (const workspace of Object.values(useWorkspaceStore.getState().workspaces)) {
      for (const tab of Object.values(workspace.tabs)) {
        if (tab.kind === 'terminal' && tab.relayLegId) {
          tabs.push({ legId: tab.relayLegId, tabId: tab.id });
        }
      }
    }
    void relay.reconcile(tabs);

    return () => {
      offLeg();
      offClose();
    };
  }, []);
}
