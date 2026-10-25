import { create } from 'zustand';

/**
 * What the user has typed into "Tag a version" for one project, plus how far the flow has
 * got. Kept out of the dialog's own state because the dialog is unmounted all the time: the
 * Workspace header replaces it when another project is activated, and the project page's copy
 * disappears the moment the user navigates (a "Review" click on a completion toast does
 * exactly that). The form has to read the same way wherever the flow is picked up again.
 */
/** A full release, or one of the pre-release channels a tag can be cut on. */
export type ReleaseChannel = 'stable' | 'beta' | 'preview';

export interface TagDraft {
  /** The tag series prefix ("v", "web-v", ...), or null until one is chosen. */
  prefix: string | null;
  /** The version itself, without the prefix. */
  version: string;
  /**
   * Which kind of release the bump buttons and AI suggestions aim at. Starts at stable every
   * time the flow does, so a beta is never cut by accident on the next release.
   */
  channel: ReleaseChannel;
  /** The annotated tag's message. */
  message: string;
  /** Why the CLI suggested this version, when it suggested one. */
  reason: string | null;
  /** The tag "Update version in files" was last started for. */
  updatedVersionFor: string | null;
}

export const EMPTY_TAG_DRAFT: TagDraft = {
  prefix: null,
  version: '',
  channel: 'stable',
  message: '',
  reason: null,
  updatedVersionFor: null,
};

interface VersionDialogState {
  /** The project whose "Tag a version" flow is showing, or null when it's closed. */
  openProjectId: string | null;
  /**
   * The tag each project is writing into its files, by project id. Kept per project so two
   * projects can each have a version bump going at once, and switching between them never
   * shows one project's run in the other's dialog.
   */
  applyTags: Record<string, string>;
  /** The unfinished tag form for each project, by project id. */
  drafts: Record<string, TagDraft>;
  open: (projectId: string) => void;
  /**
   * Closes the flow for `projectId` only. A run that finishes for one project (a tag created
   * in the background, say) must not close the dialog the user has since opened for another.
   */
  close: (projectId: string) => void;
  setApplyTag: (projectId: string, tag: string | null) => void;
  /** Merges what changed into the project's draft, leaving the rest of the form alone. */
  patchDraft: (projectId: string, patch: Partial<TagDraft>) => void;
  /** Throws the form away, for when the user closes the flow or the tag is created. */
  clearDraft: (projectId: string) => void;
}

/**
 * Kept outside the Workspace header so a version-bump run started here can be found again
 * (from a completion toast, say) even after the user has navigated away and the component
 * that opened this dialog has unmounted.
 */
export const useVersionDialogStore = create<VersionDialogState>((set) => ({
  openProjectId: null,
  applyTags: {},
  drafts: {},
  open: (projectId) => set({ openProjectId: projectId }),
  close: (projectId) =>
    set((state) => (state.openProjectId === projectId ? { openProjectId: null } : state)),
  setApplyTag: (projectId, tag) =>
    set((state) => {
      const applyTags = { ...state.applyTags };
      if (tag === null) delete applyTags[projectId];
      else applyTags[projectId] = tag;
      return { applyTags };
    }),
  patchDraft: (projectId, patch) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [projectId]: { ...EMPTY_TAG_DRAFT, ...state.drafts[projectId], ...patch },
      },
    })),
  clearDraft: (projectId) =>
    set((state) => {
      if (!state.drafts[projectId]) return state;
      const drafts = { ...state.drafts };
      delete drafts[projectId];
      return { drafts };
    }),
}));
