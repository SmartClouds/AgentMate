import type { RecipeView, RunSettingsInput, StartScenarioInput } from '@agentmat/studio';
import { useCallback, useState } from 'react';
import { create } from 'zustand';
import { getCliDefinition, launchPickLabel, type RunSettings } from '../kit';

/** "Claude Code · Opus 5.5 · High", or the CLI name alone, or "Default CLI". */
export function runLabel(run: {
  cliId?: string | null;
  cliName?: string | null;
  model?: string | null;
  effort?: RunSettings['effort'] | null;
}): string {
  if (!run.cliId) return run.cliName ? `${run.cliName} (default CLI)` : 'Default CLI';
  const name = getCliDefinition(run.cliId)?.label ?? run.cliName ?? run.cliId;
  const pick = launchPickLabel(run.cliId, {
    model: run.model ?? undefined,
    effort: run.effort ?? undefined,
  });
  return pick ? `${name} · ${pick}` : name;
}

export function toRunInput(settings: RunSettings): RunSettingsInput {
  return {
    cliId: settings.cliId ?? null,
    model: settings.model ?? null,
    effort: settings.effort ?? null,
  };
}

export function fromRunInput(run: RunSettingsInput): RunSettings {
  return {
    cliId: run.cliId ?? undefined,
    model: run.model ?? undefined,
    effort: run.effort ?? undefined,
  };
}

const STORAGE_KEY = 'studio.runSettings';
type Stage = 'scenario' | 'edit' | 'scene';

function readAll(): Partial<Record<Stage, RunSettings>> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' ? (value as Partial<Record<Stage, RunSettings>>) : {};
  } catch {
    return {};
  }
}

/**
 * The CLI, model and effort last used for a stage, remembered on this computer as a convenience.
 * Storage can be missing (a private window), so every read and write tolerates that.
 */
export function useRunSettings(stage: Stage): [RunSettings, (next: RunSettings) => void] {
  const [value, setValue] = useState<RunSettings>(() => readAll()[stage] ?? {});
  const update = useCallback(
    (next: RunSettings) => {
      setValue(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [stage]: next }));
      } catch {
        // Not remembered this time; the pick still applies.
      }
    },
    [stage],
  );
  return [value, update];
}

export type ScenarioRequest = Omit<StartScenarioInput, 'videoId'>;

interface PendingScenarioState {
  pending: { videoId: string; request: ScenarioRequest } | null;
  set: (videoId: string, request: ScenarioRequest) => void;
  /** Hands over the request for `videoId` once, then forgets it. */
  take: (videoId: string) => ScenarioRequest | null;
}

/** A scenario asked for in the New video dialog, started once the editor has the video open. */
export const usePendingScenario = create<PendingScenarioState>((set, get) => ({
  pending: null,
  set: (videoId, request) => set({ pending: { videoId, request } }),
  take: (videoId) => {
    const pending = get().pending;
    if (pending?.videoId !== videoId) return null;
    set({ pending: null });
    return pending.request;
  },
}));

/** Sets a stage's CLI, model and effort outside a component, as a recipe does for a new video. */
export function writeRunSettings(stage: Stage, settings: RunSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [stage]: settings }));
  } catch {
    // Not remembered this time.
  }
}

/** The stages' picks as a recipe keeps them. */
export function savedStageRuns(): { edit?: RunSettingsInput; scene?: RunSettingsInput } {
  const all = readAll();
  return {
    ...(all.edit ? { edit: toRunInput(all.edit) } : {}),
    ...(all.scene ? { scene: toRunInput(all.scene) } : {}),
  };
}

const VOICE_KEY = 'studio.voice';

/** The voice a video's narration starts from, chosen by the recipe it was made from. */
export function rememberVoice(videoId: string, voiceRef: string): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(VOICE_KEY) ?? '{}') as Record<
      string,
      string
    >;
    window.localStorage.setItem(VOICE_KEY, JSON.stringify({ ...all, [videoId]: voiceRef }));
  } catch {
    // Not remembered this time; the Voice view starts from its own default.
  }
}

export function rememberedVoice(videoId: string): string | null {
  try {
    const all = JSON.parse(window.localStorage.getItem(VOICE_KEY) ?? '{}') as Record<
      string,
      string
    >;
    return typeof all[videoId] === 'string' ? all[videoId] : null;
  } catch {
    return null;
  }
}

/** What a recipe sets on a new video once it is open: its render choices and its voice. */
export interface PendingRecipe {
  name: string;
  render: RecipeView['render'];
  voiceRef: string | null;
}

interface PendingRecipeState {
  pending: { videoId: string; recipe: PendingRecipe } | null;
  set: (videoId: string, recipe: PendingRecipe) => void;
  take: (videoId: string) => PendingRecipe | null;
}

export const usePendingRecipe = create<PendingRecipeState>((set, get) => ({
  pending: null,
  set: (videoId, recipe) => set({ pending: { videoId, recipe } }),
  take: (videoId) => {
    const pending = get().pending;
    if (pending?.videoId !== videoId) return null;
    set({ pending: null });
    return pending.recipe;
  },
}));
