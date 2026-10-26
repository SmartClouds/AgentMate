import { isSameOrInside, remapPath } from '@runova/core';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * The files opened most recently in each workspace, newest first, for the search dialog to
 * show before anything is typed. Paths are the full paths the file tabs use.
 */

export const MAX_RECENT_FILES = 20;
export const MAX_RECENT_PROJECTS = 50;

interface RecentFilesState {
  /** Newest project last, so the one to drop is always the first key. */
  byProject: Record<string, string[]>;
  touch: (projectId: string, path: string) => void;
  /** Follows a rename or a move, of the file or a folder above it. */
  remap: (projectId: string, from: string, to: string) => void;
  forget: (projectId: string, removed: readonly string[]) => void;
}

function withProject(
  byProject: Record<string, string[]>,
  projectId: string,
  list: string[],
): Record<string, string[]> {
  const { [projectId]: _old, ...rest } = byProject;
  const next = list.length > 0 ? { ...rest, [projectId]: list } : rest;
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_RECENT_PROJECTS))) {
    delete next[key];
  }
  return next;
}

export const useRecentFilesStore = create<RecentFilesState>()(
  persist(
    (set) => ({
      byProject: {},

      touch: (projectId, path) =>
        set((state) => {
          const list = state.byProject[projectId] ?? [];
          const next = [path, ...list.filter((one) => one !== path)].slice(0, MAX_RECENT_FILES);
          return { byProject: withProject(state.byProject, projectId, next) };
        }),

      remap: (projectId, from, to) =>
        set((state) => {
          const list = state.byProject[projectId];
          if (!list) return state;
          const next = list.map((path) => remapPath(path, from, to) ?? path);
          return { byProject: { ...state.byProject, [projectId]: [...new Set(next)] } };
        }),

      forget: (projectId, removed) =>
        set((state) => {
          const list = state.byProject[projectId];
          if (!list) return state;
          const next = list.filter((path) => !removed.some((gone) => isSameOrInside(path, gone)));
          return next.length === list.length
            ? state
            : { byProject: { ...state.byProject, [projectId]: next } };
        }),
    }),
    {
      name: 'runova-recent-files',
      version: 1,
      partialize: (state) => ({ byProject: state.byProject }),
    },
  ),
);
