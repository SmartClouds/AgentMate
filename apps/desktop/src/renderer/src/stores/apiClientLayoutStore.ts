import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Pane sizes on the API Client page, remembered between visits. */

export const API_SIDEBAR_WIDTH = { min: 200, max: 480, default: 272 } as const;
export const API_REQUEST_HEIGHT = { min: 120, max: 800, default: 300 } as const;

interface ApiClientLayoutState {
  sidebarWidth: number;
  requestHeight: number;
  setSidebarWidth: (width: number) => void;
  setRequestHeight: (height: number) => void;
}

export const useApiClientLayoutStore = create<ApiClientLayoutState>()(
  persist(
    (set) => ({
      sidebarWidth: API_SIDEBAR_WIDTH.default,
      requestHeight: API_REQUEST_HEIGHT.default,
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setRequestHeight: (requestHeight) => set({ requestHeight }),
    }),
    { name: 'runova-api-client-layout' },
  ),
);
