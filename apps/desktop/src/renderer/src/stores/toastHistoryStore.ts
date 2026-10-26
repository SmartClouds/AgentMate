import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ToastHistoryKind = 'success' | 'error' | 'warning' | 'info' | 'message';

/** Where clicking a message goes: a page inside the app, or an outside URL. */
export interface ToastHistoryLink {
  route?: string;
  url?: string;
  /** The inbox entry behind the message, so opening it can mark that read too. */
  notificationId?: string;
}

export interface ToastHistoryItem {
  id: string;
  kind: ToastHistoryKind;
  title: string;
  description: string;
  createdAt: string;
  read: boolean;
  count: number;
  link?: ToastHistoryLink;
  /** Lets the row show that project's icon. */
  projectId?: string | null;
  projectName?: string;
  /** Short outcome label such as "Failed" or "Passed". */
  tag?: string;
}

const MAX_ITEMS = 80;

interface ToastHistoryState {
  items: ToastHistoryItem[];
  open: boolean;
  setOpen: (open: boolean) => void;
  add: (item: Omit<ToastHistoryItem, 'id' | 'createdAt' | 'read' | 'count'>) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useToastHistoryStore = create<ToastHistoryState>()(
  persist(
    (set, get) => ({
      items: [],
      open: false,
      setOpen: (open) => {
        if (open) {
          set({
            open: true,
            items: get().items.map((item) => (item.read ? item : { ...item, read: true })),
          });
          return;
        }
        set({ open: false });
      },
      add: (incoming) => {
        const now = new Date().toISOString();
        const items = get().items;
        const head = items[0];
        const seen = get().open;
        if (
          head &&
          head.kind === incoming.kind &&
          head.title === incoming.title &&
          head.description === incoming.description &&
          head.link?.route === incoming.link?.route &&
          head.link?.url === incoming.link?.url
        ) {
          set({
            items: [
              { ...head, count: head.count + 1, createdAt: now, read: seen },
              ...items.slice(1),
            ],
          });
          return;
        }
        const next: ToastHistoryItem = {
          ...incoming,
          id: crypto.randomUUID(),
          createdAt: now,
          read: seen,
          count: 1,
        };
        set({ items: [next, ...items].slice(0, MAX_ITEMS) });
      },
      remove: (id) => set({ items: get().items.filter((item) => item.id !== id) }),
      clear: () => set({ items: [] }),
    }),
    {
      name: 'runova-toast-history',
      partialize: (state) => ({ items: state.items }),
    },
  ),
);
