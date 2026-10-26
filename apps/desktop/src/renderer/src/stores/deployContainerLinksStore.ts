import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Which project a server's container (or compose project) was sent to last, picked by hand when
 * the app could not tell by name (E06 T9). Remembered between visits, on this computer only.
 */

interface DeployContainerLinksState {
  /** linkKey() -> project id */
  links: Record<string, string>;
  link: (key: string, projectId: string) => void;
}

export const useDeployContainerLinksStore = create<DeployContainerLinksState>()(
  persist(
    (set) => ({
      links: {},
      link: (key, projectId) => set((state) => ({ links: { ...state.links, [key]: projectId } })),
    }),
    { name: 'runova-deploy-container-links' },
  ),
);
