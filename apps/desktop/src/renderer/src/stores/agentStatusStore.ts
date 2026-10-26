import { type AgentStatus, type AutoContinuePending, catalogModelForApiId } from '@runova/core';
import type {
  AgentRunInfo,
  AgentRunInfoMap,
  AgentSessionEntry,
  AgentStatusMap,
  AutoContinuePendingMap,
} from '@shared/apiTypes';
import { create } from 'zustand';
import { prepareStatusHooks } from '@/lib/workspace/launch';
import { useCliStore } from './cliStore';
import { terminalTabLabel, useWorkspaceStore } from './workspaceStore';

interface AgentStatusState {
  statuses: AgentStatusMap;
  /** The model and effort each agent last reported, for tab tooltips. */
  runInfos: AgentRunInfoMap;
  /** The "continue" each tab has scheduled after a usage limit or a network error. */
  autoContinue: AutoContinuePendingMap;
}

/** What each workspace tab's agent is doing, as main last reported it. Not persisted. */
export const useAgentStatusStore = create<AgentStatusState>(() => ({
  statuses: {},
  runInfos: {},
  autoContinue: {},
}));

export function useAgentStatus(sessionId: string): AgentStatus {
  return useAgentStatusStore((s) => s.statuses[sessionId] ?? 'idle');
}

export function useAgentRunInfo(sessionId: string): AgentRunInfo | undefined {
  return useAgentStatusStore((s) => s.runInfos[sessionId]);
}

/**
 * The tooltip model line for a tab, newest signal first: what the agent
 * reports right now, what the tab was launched with, what the CLI was last
 * run on, what the CLI opens with by default. Only Claude Code reports live
 * (it is the only CLI with status hooks), so every other agent leans on the
 * launch-time and configured values.
 */
export function tabRunLine(
  runInfo: AgentRunInfo | undefined,
  runLabel: string | null | undefined,
  cliFallback: string | null,
): string | null {
  if (runInfo?.model || runInfo?.effort) {
    return [
      runInfo.model ? modelDisplayName(runInfo.model) : null,
      runInfo.effort ? `${runInfo.effort} effort` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return runLabel ?? cliFallback;
}

/**
 * The model line for a CLI whose agent never reports one: what it was last
 * run on, else its launch default. Null when nothing is known, so the tab
 * shows no model rather than a made-up one.
 */
export function useCliRunLine(cliId: string | undefined): string | null {
  return useCliStore((s) => {
    if (!cliId) return null;
    const last = s.lastRunInfoByCli[cliId];
    if (last?.model || last?.effort) {
      return (
        [
          last.model ? modelDisplayName(last.model) : null,
          last.effort ? `${last.effort} effort` : null,
        ]
          .filter(Boolean)
          .join(' · ') || null
      );
    }
    const model = s.cliLaunchDefaults[cliId]?.model;
    return model ? modelDisplayName(model) : null;
  });
}

export function useAutoContinuePending(sessionId: string): AutoContinuePending | null {
  return useAgentStatusStore((s) => s.autoContinue[sessionId] ?? null);
}

/** A model id as people say it: `claude-opus-5-5-20260101` becomes "Opus 5.5". */
export function modelDisplayName(model: string): string {
  const known = catalogModelForApiId(model);
  if (known) return /\[1m\]$/i.test(model.trim()) ? `${known.label} (1M)` : known.label;
  const trimmed = model
    .replace(/^claude-/i, '')
    .replace(/-\d{8}$/, '')
    .replace(/\[1m\]$/i, ' (1M)');
  return trimmed
    .split('-')
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
    .replace(/(\d) (\d)/g, '$1.$2');
}

/**
 * The session is in the middle of something closing it would cut short: working, or stopped
 * on a question. A tab that was just opened, or whose agent already finished, is not.
 */
export function isSessionBusy(sessionId: string): boolean {
  const status = useAgentStatusStore.getState().statuses[sessionId];
  return status === 'working' || status === 'needs-input';
}

function sessionEntries(): AgentSessionEntry[] {
  const entries: AgentSessionEntry[] = [];
  for (const [projectId, workspace] of Object.entries(useWorkspaceStore.getState().workspaces)) {
    for (const tab of Object.values(workspace.tabs)) {
      if (tab.kind !== 'terminal') continue;
      entries.push({
        sessionId: tab.id,
        projectId,
        cliId: tab.cliId,
        title: terminalTabLabel(tab),
        autoContinue: tab.autoContinue,
      });
    }
  }
  return entries;
}

/**
 * Copies the conversation ids agents report onto their tabs. Main only holds them for as long
 * as it runs, and a tab needs its id after a crash or reboot to pick the conversation back up.
 */
function rememberConversations(runInfos: AgentRunInfoMap): void {
  const store = useWorkspaceStore.getState();
  for (const [projectId, workspace] of Object.entries(store.workspaces)) {
    for (const tab of Object.values(workspace.tabs)) {
      const conversationId = runInfos[tab.id]?.conversationId;
      if (tab.kind === 'terminal' && tab.cliId && conversationId) {
        store.setConversationId(projectId, tab.id, conversationId);
      }
    }
  }
}

let started = false;

/**
 * Starts following agent status for the whole app: sends main the workspace's tabs (and
 * keeps that list current) and mirrors every status change main pushes back.
 */
export function initAgentStatus(): void {
  if (started) return;
  started = true;
  const agents = window.runova.agents;
  prepareStatusHooks(['claude-code']);

  agents.onStatus((changes) => {
    useAgentStatusStore.setState((state) => ({ statuses: { ...state.statuses, ...changes } }));
  });
  agents.onAutoContinue((changes) => {
    useAgentStatusStore.setState((state) => ({
      autoContinue: { ...state.autoContinue, ...changes },
    }));
  });
  agents.onRunInfo((changes) => {
    useAgentStatusStore.setState((state) => ({ runInfos: { ...state.runInfos, ...changes } }));
    rememberConversations(changes);
    // Keeps the "last run" cache current through the session, so a fresh tab opened
    // right after a `/model` switch already knows about it, not just after a restart.
    for (const entry of sessionEntries()) {
      const info = changes[entry.sessionId];
      if (info?.model && entry.cliId) {
        useCliStore.getState().recordLastRun(entry.cliId, info.model, info.effort);
      }
    }
  });

  let lastSignature = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sync = (): void => {
    timer = null;
    const entries = sessionEntries();
    const signature = JSON.stringify(entries);
    if (signature === lastSignature) return;
    lastSignature = signature;
    void agents.sync(entries).then(async () => {
      const [statuses, runInfos, autoContinue] = await Promise.all([
        agents.list(),
        agents.runInfos(),
        agents.autoContinuePending(),
      ]);
      useAgentStatusStore.setState({ statuses, runInfos, autoContinue });
      rememberConversations(runInfos);
    });
  };
  sync();
  useWorkspaceStore.subscribe((state, previous) => {
    if (state.workspaces === previous.workspaces || timer) return;
    timer = setTimeout(sync, 150);
  });
}

/** Which tabs need attention, rolled up for a badge. Idle and exited tabs never do. */
export function attentionStatus(statuses: AgentStatus[]): AgentStatus | null {
  if (statuses.includes('needs-input')) return 'needs-input';
  if (statuses.includes('done')) return 'done';
  if (statuses.includes('working')) return 'working';
  return null;
}
