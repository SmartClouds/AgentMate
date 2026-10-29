import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Which of an environment's files an app's .env was last made from, when not all of them. The
 * server only keeps the environment, so this is how deploying the app again starts from the same
 * files. Remembered between visits, on this computer only.
 */

export interface AppEnvFilesPick {
  environmentId: string;
  envFileIds: string[];
}

interface DeployAppEnvFilesState {
  /** appEnvFilesKey() -> the pick */
  picks: Record<string, AppEnvFilesPick>;
  /** Keeps the pick; a null environment or null files (every file) forgets it. */
  remember: (
    serverId: string,
    stackId: string,
    environmentId: string | null,
    envFileIds: string[] | null,
  ) => void;
}

export function appEnvFilesKey(serverId: string, stackId: string): string {
  return `${serverId}:${stackId}`;
}

export const useDeployAppEnvFilesStore = create<DeployAppEnvFilesState>()(
  persist(
    (set) => ({
      picks: {},
      remember: (serverId, stackId, environmentId, envFileIds) =>
        set((state) => {
          const key = appEnvFilesKey(serverId, stackId);
          const { [key]: _old, ...rest } = state.picks;
          return {
            picks:
              environmentId && envFileIds
                ? { ...rest, [key]: { environmentId, envFileIds: [...envFileIds] } }
                : rest,
          };
        }),
    }),
    { name: 'runova-deploy-app-env-files' },
  ),
);

/** The files to start from for this app and environment: the remembered pick, or null for all. */
export function rememberedEnvFiles(
  serverId: string,
  stackId: string,
  environmentId: string | null,
): string[] | null {
  if (!environmentId) return null;
  const pick = useDeployAppEnvFilesStore.getState().picks[appEnvFilesKey(serverId, stackId)];
  return pick && pick.environmentId === environmentId ? pick.envFileIds : null;
}
