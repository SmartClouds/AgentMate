import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { BrowserAnnotation, PageMarker } from '@/lib/browser/types';

/**
 * State of the workspace browser tabs that isn't part of the pane layout: the comments left on
 * page elements, waiting to be sent to an agent, and the addresses opened recently per project.
 *
 * Comments live only as long as the app runs. Their screenshots are swept after a week and the
 * elements they point at may be gone after a reload, so bringing them back later would do more
 * harm than good.
 */

export const MAX_ANNOTATIONS_PER_TAB = 20;
const MAX_RECENT = 8;

type AnnotationDraft = Omit<BrowserAnnotation, 'id' | 'createdAt'>;
type AnnotationPatch = Partial<
  Pick<BrowserAnnotation, 'comment' | 'intent' | 'screenshotPath' | 'thumbDataUrl'>
>;

interface BrowserState {
  annotations: Record<string, BrowserAnnotation[]>;
  recentUrls: Record<string, string[]>;
  /** Adds a comment and returns its id, or null when the tab already holds the most it can. */
  addAnnotation: (draft: AnnotationDraft) => string | null;
  updateAnnotation: (tabId: string, id: string, patch: AnnotationPatch) => void;
  removeAnnotation: (tabId: string, id: string) => void;
  removeAnnotations: (tabId: string, ids: readonly string[]) => void;
  clearTab: (tabId: string) => void;
  rememberUrl: (projectId: string, url: string) => void;
}

function withTab(
  annotations: Record<string, BrowserAnnotation[]>,
  tabId: string,
  list: BrowserAnnotation[],
): Record<string, BrowserAnnotation[]> {
  if (list.length > 0) return { ...annotations, [tabId]: list };
  const { [tabId]: _gone, ...rest } = annotations;
  return rest;
}

export const useBrowserStore = create<BrowserState>()(
  persist(
    (set, get) => ({
      annotations: {},
      recentUrls: {},

      addAnnotation: (draft) => {
        const list = get().annotations[draft.tabId] ?? [];
        if (list.length >= MAX_ANNOTATIONS_PER_TAB) return null;
        const annotation: BrowserAnnotation = {
          ...draft,
          id: crypto.randomUUID(),
          createdAt: Date.now(),
        };
        set((state) => ({
          annotations: { ...state.annotations, [draft.tabId]: [...list, annotation] },
        }));
        return annotation.id;
      },

      updateAnnotation: (tabId, id, patch) =>
        set((state) => {
          const list = state.annotations[tabId];
          if (!list?.some((one) => one.id === id)) return state;
          return {
            annotations: {
              ...state.annotations,
              [tabId]: list.map((one) => (one.id === id ? { ...one, ...patch } : one)),
            },
          };
        }),

      removeAnnotation: (tabId, id) => get().removeAnnotations(tabId, [id]),

      removeAnnotations: (tabId, ids) =>
        set((state) => {
          const list = state.annotations[tabId];
          if (!list) return state;
          const drop = new Set(ids);
          return {
            annotations: withTab(
              state.annotations,
              tabId,
              list.filter((one) => !drop.has(one.id)),
            ),
          };
        }),

      clearTab: (tabId) =>
        set((state) =>
          state.annotations[tabId] ? { annotations: withTab(state.annotations, tabId, []) } : state,
        ),

      rememberUrl: (projectId, url) =>
        set((state) => {
          if (!/^https?:\/\//i.test(url)) return state;
          const list = state.recentUrls[projectId] ?? [];
          if (list[0] === url) return state;
          const next = [url, ...list.filter((one) => one !== url)].slice(0, MAX_RECENT);
          return { recentUrls: { ...state.recentUrls, [projectId]: next } };
        }),
    }),
    {
      name: 'runova-browser',
      version: 1,
      partialize: (state) => ({ recentUrls: state.recentUrls }),
    },
  ),
);

function withoutHash(url: string): string {
  const at = url.indexOf('#');
  // A hash route is a different page, a plain fragment is the same one.
  if (at === -1 || url.startsWith('#/', at)) return url;
  return url.slice(0, at);
}

/** Pins for the comments left on the page at `url`, numbered in the order they were left. */
export function markersFor(annotations: readonly BrowserAnnotation[], url: string): PageMarker[] {
  const page = withoutHash(url);
  return annotations.flatMap((annotation, index) =>
    withoutHash(annotation.page.url) === page
      ? [
          {
            n: index + 1,
            id: annotation.id,
            rectPage: annotation.element.rectPage,
            rectViewport: annotation.element.rectViewport,
            fixed: annotation.element.fixed,
          },
        ]
      : [],
  );
}
