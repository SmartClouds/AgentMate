import type { RemoteFileManagerEntry } from '@shared/apiTypes';
import { toast } from 'sonner';
import { create } from 'zustand';

interface RemoteFileManagerState {
  /** Absolute path currently browsed on the peer, or null while showing roots (drives/home). */
  path: string | null;
  entries: RemoteFileManagerEntry[];
  roots: RemoteFileManagerEntry[];
  loading: boolean;
  error: string | null;

  loadRoots: () => Promise<void>;
  navigate: (path: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  mkdir: (name: string) => Promise<void>;
  deleteEntry: (entry: RemoteFileManagerEntry) => Promise<void>;
  rename: (entry: RemoteFileManagerEntry, newName: string) => Promise<void>;
  upload: () => Promise<void>;
  download: (entry: RemoteFileManagerEntry) => Promise<void>;
}

export const useRemoteFileManagerStore = create<RemoteFileManagerState>((set, get) => ({
  path: null,
  entries: [],
  roots: [],
  loading: false,
  error: null,

  loadRoots: async () => {
    set({ loading: true, error: null });
    try {
      const roots = await window.runova.remote.fmRoots();
      set({ roots, path: null, entries: [], loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  navigate: async (path) => {
    set({ loading: true, error: null });
    try {
      const result = await window.runova.remote.fmList(path);
      set({ path: result.path, entries: result.entries, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
      toast.error(`Could not open that folder: ${(err as Error).message}`);
    }
  },

  refresh: async () => {
    const { path, loadRoots, navigate } = get();
    if (path === null) await loadRoots();
    else await navigate(path);
  },

  mkdir: async (name) => {
    const { path } = get();
    if (path === null) return;
    try {
      await window.runova.remote.fmMkdir(path, name);
      await get().refresh();
    } catch (err) {
      toast.error(`Could not create the folder: ${(err as Error).message}`);
    }
  },

  deleteEntry: async (entry) => {
    try {
      await window.runova.remote.fmDelete(entry.path);
      await get().refresh();
    } catch (err) {
      toast.error(`Could not delete "${entry.name}": ${(err as Error).message}`);
    }
  },

  rename: async (entry, newName) => {
    try {
      await window.runova.remote.fmRename(entry.path, newName);
      await get().refresh();
    } catch (err) {
      toast.error(`Could not rename "${entry.name}": ${(err as Error).message}`);
    }
  },

  upload: async () => {
    const { path } = get();
    if (path === null) {
      toast.error('Open a folder before uploading into it.');
      return;
    }
    try {
      await window.runova.remote.fmUploadTo(path);
    } catch (err) {
      toast.error(`Upload failed: ${(err as Error).message}`);
    }
  },

  download: async (entry) => {
    try {
      await window.runova.remote.fmDownload(entry.path);
    } catch (err) {
      toast.error(`Could not download "${entry.name}": ${(err as Error).message}`);
    }
  },
}));
