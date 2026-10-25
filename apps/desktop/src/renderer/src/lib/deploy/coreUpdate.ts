import type { DeployCoreRelease, DeploySetupPhase } from '@shared/deployTypes';
import { useQuery } from '@tanstack/react-query';
import { compareVersions } from '@/components/deploy/wordpress/messages';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The steps of an update through the core itself. A packaged build's release is on GitHub, so the
 * server downloads it; a development build's is uploaded. When the server's own download fails,
 * the upload steps show up where they happen.
 */
export function coreUpdatePhases(
  release: Pick<DeployCoreRelease, 'serverDownload'>,
): DeploySetupPhase[] {
  return release.serverDownload
    ? ['fetch', 'switch', 'health']
    : ['download', 'upload', 'switch', 'health'];
}

/** The release to offer when it is newer than what runs; null when there is nothing newer. */
export function newerCore(
  running: string | undefined,
  release: DeployCoreRelease | null | undefined,
): DeployCoreRelease | null {
  if (!running || !release) return null;
  return compareVersions(release.version, running) > 0 ? release : null;
}

/** What this build installs. It cannot change while the app runs. */
export function useCoreRelease() {
  return useQuery({
    queryKey: queryKeys.deployCoreRelease,
    queryFn: () => window.agentmat.deploy.coreRelease(),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { silentLoading: true },
  });
}
