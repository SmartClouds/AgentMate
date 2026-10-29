import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * What the Deploy page had open last, as the part of its address that says so. Remembered between
 * visits and between starts, on this computer only.
 */

interface DeploySelectionState {
  search: string | null;
  remember: (search: string | null) => void;
}

export const useDeploySelectionStore = create<DeploySelectionState>()(
  persist(
    (set) => ({
      search: null,
      remember: (search) => set({ search }),
    }),
    { name: 'runova-deploy-selection' },
  ),
);
