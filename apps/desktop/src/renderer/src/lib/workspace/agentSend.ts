import { getCliDefinition, type Project } from '@runova/core';
import { toast } from 'sonner';
import { terminalRuntime, useTerminalSessionStore } from '@/lib/terminal/terminalRuntime';
import { findAgentTerminal } from '@/lib/workspace/agentTarget';
import { launchPromptTab, projectCliId } from '@/lib/workspace/launch';
import { useWorkspaceStore, type WorkspaceTerminalTab } from '@/stores/workspaceStore';

/**
 * Types text into an agent CLI running in the workspace, unsubmitted, so the user reads it over
 * and presses Enter there. Used for files handed over from the explorer and for comments left on
 * page elements in a browser tab.
 */

export interface DeliverOptions {
  /** The text for a given CLI, since some take file references in their own form. */
  build: (cliId: string) => string;
  /** What is being sent, for the clipboard fallback: "Your comments are on your clipboard". */
  what: string;
  /** A specific agent tab, or a new tab of a specific CLI. Otherwise the usual agent. */
  target?: { tabId: string } | { newCliId: string };
}

export interface DeliverResult {
  /** `launched` means a new tab was started and will get the text once its CLI is ready. */
  outcome: 'pasted' | 'launched' | 'clipboard';
  tabId: string;
  cliId: string;
}

function targetTab(projectId: string, tabId: string): WorkspaceTerminalTab | null {
  const tab = useWorkspaceStore.getState().workspaces[projectId]?.tabs[tabId];
  if (tab?.kind !== 'terminal' || !tab.cliId) return null;
  return useTerminalSessionStore.getState().ended[tab.id] ? null : tab;
}

function launch(project: Project, cliId: string | null, build: DeliverOptions['build']) {
  if (!cliId) {
    toast.error('No agent CLI to ask', {
      description: 'Pick a default CLI in Settings, or start one in this workspace.',
    });
    return null;
  }
  const tabId = launchPromptTab(project, { cliId, prompt: build(cliId) });
  if (!tabId) return null;
  terminalRuntime.focus(tabId);
  return { outcome: 'launched', tabId, cliId } satisfies DeliverResult;
}

/**
 * Sends the text and says how it went, or null when there was nowhere to send it. The paste into
 * a ready CLI happens before this returns its promise, so callers that don't wait still see it.
 */
export async function deliverToAgent(
  project: Project,
  { build, what, target }: DeliverOptions,
): Promise<DeliverResult | null> {
  if (target && 'newCliId' in target) return launch(project, target.newCliId, build);

  const tab =
    (target && 'tabId' in target ? targetTab(project.id, target.tabId) : null) ??
    findAgentTerminal(project.id);
  if (!tab?.cliId) return launch(project, projectCliId(project), build);

  const cliId = tab.cliId;
  const text = build(cliId);
  useWorkspaceStore.getState().activateTab(project.id, tab.id);
  terminalRuntime.focus(tab.id);
  if (terminalRuntime.insertText(tab.id, text)) return { outcome: 'pasted', tabId: tab.id, cliId };
  // The CLI is still starting, or its terminal was let go while off screen and is coming back.
  if (await terminalRuntime.deliverPrompt(tab.id, text)) {
    return { outcome: 'pasted', tabId: tab.id, cliId };
  }
  void navigator.clipboard.writeText(text);
  toast.warning(`${getCliDefinition(cliId)?.name ?? 'The CLI'} is not taking input`, {
    description: `${what} ${/s$/.test(what) ? 'are' : 'is'} on your clipboard, ready to paste.`,
  });
  return { outcome: 'clipboard', tabId: tab.id, cliId };
}
