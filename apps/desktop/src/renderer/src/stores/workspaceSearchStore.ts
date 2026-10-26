import type { TextSearchOptions } from '@shared/apiTypes';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * The workspace search dialog: whether it is open and for which project, and what it keeps
 * between openings (the last query per project, the text options, the preview's size), the
 * way Visual Studio's Go to All picks up where it was left.
 */

export const PREVIEW_MIN = 0.25;
export const PREVIEW_MAX = 0.75;
export const PREVIEW_DEFAULT = 0.45;

export interface PreviewLayout {
  visible: boolean;
  /** How much of the dialog's height the preview takes. */
  ratio: number;
  /** Draw pictures in the preview. Off, they are not read at all, which spares big files. */
  images: boolean;
}

interface WorkspaceSearchState {
  open: boolean;
  /** The workspace scope the dialog searches. */
  projectId: string | null;
  queries: Record<string, string>;
  options: TextSearchOptions;
  preview: PreviewLayout;
  /** Opens for a project, starting from `seed` when given, or from the last query. */
  openSearch: (projectId: string, seed?: string) => void;
  close: () => void;
  toggle: (projectId: string) => void;
  setQuery: (projectId: string, query: string) => void;
  setOption: (option: keyof TextSearchOptions, value: boolean) => void;
  setPreview: (patch: Partial<PreviewLayout>) => void;
}

export const useWorkspaceSearchStore = create<WorkspaceSearchState>()(
  persist(
    (set, get) => ({
      open: false,
      projectId: null,
      queries: {},
      options: { matchCase: false, wholeWord: false, regex: false },
      preview: { visible: true, ratio: PREVIEW_DEFAULT, images: true },

      openSearch: (projectId, seed) =>
        set((state) => ({
          open: true,
          projectId,
          queries: seed === undefined ? state.queries : { ...state.queries, [projectId]: seed },
        })),

      close: () => set({ open: false }),

      toggle: (projectId) => {
        const { open, projectId: current } = get();
        if (open && current === projectId) set({ open: false });
        else get().openSearch(projectId);
      },

      setQuery: (projectId, query) =>
        set((state) => ({ queries: { ...state.queries, [projectId]: query } })),

      setOption: (option, value) =>
        set((state) => ({ options: { ...state.options, [option]: value } })),

      setPreview: (patch) =>
        set((state) => {
          const next = { ...state.preview, ...patch };
          next.ratio = Math.min(PREVIEW_MAX, Math.max(PREVIEW_MIN, next.ratio));
          return { preview: next };
        }),
    }),
    {
      name: 'runova-workspace-search',
      version: 1,
      partialize: (state) => ({
        queries: state.queries,
        options: state.options,
        preview: state.preview,
      }),
      // The preview is merged field by field, so a layout saved before a field existed picks up
      // that field's default instead of leaving it undefined.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<WorkspaceSearchState>;
        return { ...current, ...saved, preview: { ...current.preview, ...saved.preview } };
      },
    },
  ),
);
