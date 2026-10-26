import { allGroups, findGroup } from '@runova/core';
import { useTerminalSessionStore } from '@/lib/terminal/terminalRuntime';
import { useWorkspaceStore, type WorkspaceTerminalTab } from '@/stores/workspaceStore';

/** The agent tab the user last typed in, per workspace. Only needed while the app is open. */
const lastAgentTab = new Map<string, string>();

/** Remembers an agent tab the user focused, so it wins over other agents in the workspace. */
export function rememberAgentTab(projectId: string, tabId: string): void {
  lastAgentTab.set(projectId, tabId);
}

/** Test hook. */
export function forgetAgentTabs(): void {
  lastAgentTab.clear();
}

/**
 * The agent CLI in a workspace that files handed over from the explorer should go to. Opening a
 * file from the explorer puts a file tab in front, so the focused pane alone is not enough:
 * after it come the agent the user last focused, one on screen in another pane, and finally the
 * newest one. Tabs whose shell has ended are skipped. Null when no agent is running.
 */
export function findAgentTerminal(projectId: string): WorkspaceTerminalTab | null {
  const ws = useWorkspaceStore.getState().workspaces[projectId];
  if (!ws) return null;
  const ended = useTerminalSessionStore.getState().ended;
  const agentTab = (id: string | null | undefined): WorkspaceTerminalTab | null => {
    const tab = id ? ws.tabs[id] : undefined;
    return tab?.kind === 'terminal' && tab.cliId && !ended[tab.id] ? tab : null;
  };

  const focused = agentTab(findGroup(ws.root, ws.focusedGroupId)?.activeTabId);
  if (focused) return focused;
  const last = agentTab(lastAgentTab.get(projectId));
  if (last) return last;
  for (const group of allGroups(ws.root)) {
    const visible = agentTab(group.activeTabId);
    if (visible) return visible;
  }
  let newest: WorkspaceTerminalTab | null = null;
  for (const id of Object.keys(ws.tabs)) {
    const tab = agentTab(id);
    if (tab && (!newest || tab.createdAt > newest.createdAt)) newest = tab;
  }
  return newest;
}

/**
 * Every running agent tab in a workspace, the one `findAgentTerminal` picks first and the rest
 * oldest first, so a menu can offer them all as places to send something.
 */
export function listAgentTerminals(projectId: string): WorkspaceTerminalTab[] {
  const ws = useWorkspaceStore.getState().workspaces[projectId];
  if (!ws) return [];
  const ended = useTerminalSessionStore.getState().ended;
  const preferred = findAgentTerminal(projectId);
  const rest = Object.values(ws.tabs)
    .filter(
      (tab): tab is WorkspaceTerminalTab =>
        tab.kind === 'terminal' && !!tab.cliId && !ended[tab.id] && tab.id !== preferred?.id,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  return preferred ? [preferred, ...rest] : rest;
}
