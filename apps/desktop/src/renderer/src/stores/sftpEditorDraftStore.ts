import type { SftpTextFile } from '@shared/sftpTypes';
import { create } from 'zustand';

/**
 * Unsaved edits of the remote file editor (E25), kept outside the dialog so they survive its
 * unmount. The docked file manager drops its dialogs while its drawer tab is hidden, and the
 * shortcut that hides the drawer is not stopped by a dialog, so a draft held only in the dialog
 * would be thrown away without the usual "Discard your changes?" question.
 *
 * Kept in memory only, and only while unsaved: a save or a discard clears it.
 */

export interface EditorDraft {
  /** What the user typed. */
  content: string;
  /** The file as it was read, whose size and time a save sends to catch a change on the server. */
  base: SftpTextFile;
}

interface SftpEditorDraftState {
  drafts: Record<string, EditorDraft>;
  setDraft: (key: string, draft: EditorDraft) => void;
  clearDraft: (key: string) => void;
}

/** One draft per server and remote path. */
export function editorDraftKey(serverId: string, path: string): string {
  return `${serverId}\n${path}`;
}

export const useSftpEditorDraftStore = create<SftpEditorDraftState>()((set) => ({
  drafts: {},
  setDraft: (key, draft) => set((state) => ({ drafts: { ...state.drafts, [key]: draft } })),
  clearDraft: (key) =>
    set((state) => {
      if (!(key in state.drafts)) return state;
      const drafts = { ...state.drafts };
      delete drafts[key];
      return { drafts };
    }),
}));
