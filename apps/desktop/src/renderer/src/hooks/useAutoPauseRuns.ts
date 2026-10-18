import {
  type AutoPauseAgent,
  type AutoPauseRun,
  emptyAutoPauseMemory,
  planAgentRunPause,
} from '@agentmat/core';
import { useEffect, useRef, useState } from 'react';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { pauseRuns, resumeRuns, useRunPauseStore } from '@/stores/runPauseStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useAutoPauseRunsSetting } from './useAutoPauseRunsSetting';
import { isPausable, useRunRows } from './useRunRows';

/** How often the rules are looked at again while a paused run waits out the resume delay. */
const RECHECK_MS = 1000;

/**
 * Pauses a project's runs while an agent works in the same folder, and resumes them a few
 * seconds after it stops, when the setting is on. Mounted once, in the app shell. The rules
 * live in core (`planAgentRunPause`); this feeds them what the stores say and acts on the answer.
 */
export function useAutoPauseRuns(): void {
  const { loaded, enabled } = useAutoPauseRunsSetting();
  const rows = useRunRows();
  const pending = useRunPauseStore((s) => s.pending);
  const statuses = useAgentStatusStore((s) => s.statuses);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const memory = useRef(emptyAutoPauseMemory());
  const [tick, setTick] = useState(0);

  const runs: AutoPauseRun[] = rows.map((row) => ({
    id: row.session.id,
    cwd: row.session.cwd ?? '',
    active: isPausable(row),
    paused: row.pause?.reason ?? null,
    pending: pending[row.session.id] !== undefined,
  }));
  const agents: AutoPauseAgent[] = [];
  for (const workspace of Object.values(workspaces)) {
    for (const tab of Object.values(workspace.tabs)) {
      if (tab.kind !== 'terminal' || !tab.cliId) continue;
      agents.push({ id: tab.id, cwd: tab.cwd, working: statuses[tab.id] === 'working' });
    }
  }
  // A signature, so the effect runs when what the rules see changes, not on every render.
  const signature = JSON.stringify([enabled, runs, agents]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature stands for runs and agents, and tick asks for a fresh look
  useEffect(() => {
    // Before the setting loads, "off" would resume runs the agent paused before a reload.
    if (!loaded) return;
    const plan = planAgentRunPause({
      runs,
      agents,
      memory: memory.current,
      now: Date.now(),
      enabled,
    });
    memory.current = plan.memory;
    if (plan.pause.length > 0) void pauseRuns(plan.pause, { reason: 'agent', quiet: true });
    if (plan.resume.length > 0) void resumeRuns(plan.resume, { quiet: true });

    const waiting =
      enabled &&
      (runs.some((run) => run.paused === 'agent') || plan.memory.overridden.length > 0);
    if (!waiting) return;
    const timer = setTimeout(() => setTick((value) => value + 1), RECHECK_MS);
    return () => clearTimeout(timer);
  }, [loaded, signature, tick]);
}
