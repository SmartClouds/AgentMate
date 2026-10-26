import type { CliArgsMap, CliLaunchDefault, CliLaunchDefaultsMap } from '@runova/core';
import type { LastRunInfoByCli } from '@shared/apiTypes';
import { create } from 'zustand';

interface CliState {
  defaultCliId: string | null;
  /** Extra arguments per CLI id, typed as a command line (e.g. "--model sonnet"). */
  cliArgs: CliArgsMap;
  /** Model, effort, and mode each CLI opens with in a terminal. Unset fields add no flag. */
  cliLaunchDefaults: CliLaunchDefaultsMap;
  /** The user's order for listing agents to launch. Empty means the default order. */
  cliOrder: string[];
  /** The model and effort each CLI was last actually run on, kept across restarts. */
  lastRunInfoByCli: LastRunInfoByCli;
  setDefaultCliId: (cliId: string | null) => void;
  setCliArgs: (cliId: string, args: string) => void;
  setCliLaunchDefault: (cliId: string, patch: Partial<CliLaunchDefault>) => void;
  clearCliLaunchDefault: (cliId: string) => void;
  setCliOrder: (order: string[]) => void;
  recordLastRun: (cliId: string, model?: string, effort?: string) => void;
}

export const useCliStore = create<CliState>((set, get) => ({
  defaultCliId: null,
  cliArgs: {},
  cliLaunchDefaults: {},
  cliOrder: [],
  lastRunInfoByCli: {},
  setDefaultCliId: (cliId) => {
    set({ defaultCliId: cliId });
    void window.runova.settings.update({ defaultCliId: cliId });
  },
  setCliArgs: (cliId, args) => {
    const next = { ...get().cliArgs };
    // An emptied field means "no extra args", so drop the key instead of storing ''.
    if (args.trim()) next[cliId] = args.trim();
    else delete next[cliId];
    set({ cliArgs: next });
    void window.runova.settings.update({ cliArgs: next });
  },
  setCliLaunchDefault: (cliId, patch) => {
    const merged: CliLaunchDefault = { ...get().cliLaunchDefaults[cliId], ...patch };
    // A field set back to "not set" is removed, not stored empty, so it never reaches a launch.
    for (const key of Object.keys(merged) as (keyof CliLaunchDefault)[]) {
      if (!merged[key]) delete merged[key];
    }
    const next = { ...get().cliLaunchDefaults };
    if (Object.keys(merged).length) next[cliId] = merged;
    else delete next[cliId];
    set({ cliLaunchDefaults: next });
    void window.runova.settings.update({ cliLaunchDefaults: next });
  },
  clearCliLaunchDefault: (cliId) => {
    if (!get().cliLaunchDefaults[cliId]) return;
    const next = { ...get().cliLaunchDefaults };
    delete next[cliId];
    set({ cliLaunchDefaults: next });
    void window.runova.settings.update({ cliLaunchDefaults: next });
  },
  setCliOrder: (order) => {
    set({ cliOrder: order });
    void window.runova.settings.update({ cliOrder: order });
  },
  recordLastRun: (cliId, model, effort) => {
    if (!model) return;
    const current = get().lastRunInfoByCli[cliId];
    if (current?.model === model && current?.effort === effort) return;
    set({ lastRunInfoByCli: { ...get().lastRunInfoByCli, [cliId]: { model, effort } } });
  },
}));

export async function initDefaultCli(): Promise<void> {
  const [settings, lastRunInfoByCli] = await Promise.all([
    window.runova.settings.get(),
    window.runova.agents.lastRunInfoByCli(),
  ]);
  useCliStore.setState({
    defaultCliId: settings.defaultCliId,
    cliArgs: settings.cliArgs ?? {},
    cliLaunchDefaults: settings.cliLaunchDefaults ?? {},
    cliOrder: settings.cliOrder ?? [],
    lastRunInfoByCli,
  });
}
