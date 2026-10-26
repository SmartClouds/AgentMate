import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SidebarMode = 'expanded' | 'collapsed' | 'hidden';

// Cycle order for the single toggle button: full labels, icons only, then
// closed completely (no width at all, so it pushes the page content back
// over instead of floating a panel on top of it).
const SIDEBAR_MODE_CYCLE: SidebarMode[] = ['expanded', 'collapsed', 'hidden'];

interface UiState {
  sidebarMode: SidebarMode;
  cycleSidebarMode: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarMode: 'expanded',
      cycleSidebarMode: () =>
        set((s) => {
          const nextIndex =
            (SIDEBAR_MODE_CYCLE.indexOf(s.sidebarMode) + 1) % SIDEBAR_MODE_CYCLE.length;
          return { sidebarMode: SIDEBAR_MODE_CYCLE[nextIndex] };
        }),
    }),
    { name: 'runova-ui' },
  ),
);
