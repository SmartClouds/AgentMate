import type { DevDetection, DevUpdateCheck } from '@runova/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';

/**
 * What the Packages tab needs from Dev Setup about one tool: the installed version, whether a
 * newer one is on offer, and a way to start the update. The queries share their keys with the
 * Dev Setup page, so a version found or updated on one screen is current on the other.
 */

const TOOLCHAIN_NAMES: Record<string, string> = {
  bun: 'Bun',
  node: 'Node.js',
  'dotnet-sdk': '.NET SDK',
  flutter: 'Flutter',
  dart: 'Dart',
};

const TOOLCHAIN_STACKS: Record<string, string> = {
  bun: 'essentials',
  node: 'essentials',
  'dotnet-sdk': 'dotnet',
  flutter: 'flutter',
  dart: 'flutter',
};

export function toolchainName(id: string): string {
  return TOOLCHAIN_NAMES[id] ?? id;
}

/** Dev Setup with the tool's stack switched on, so its row is on the page. */
export function devSetupLink(id: string): string {
  const stack = TOOLCHAIN_STACKS[id];
  return `/tools?tab=dev-setup${stack ? `&stack=${stack}` : ''}`;
}

export interface ToolchainStatus {
  detection: DevDetection | undefined;
  installedVersion: string | null;
  update: DevUpdateCheck | undefined;
  upgrading: boolean;
  /**
   * Starts the update in Dev Setup's queue. `manual` means Dev Setup can't run it from here (it
   * needs a terminal or admin rights, or there is nothing it knows to run), so the caller should
   * send the person to the Dev Setup page.
   */
  upgrade(): Promise<'started' | 'manual'>;
}

export function useToolchainStatus(id: string | null): ToolchainStatus {
  const queryClient = useQueryClient();
  const [upgrading, setUpgrading] = useState(false);

  const detection = useQuery({
    queryKey: queryKeys.devSetupItem(id ?? ''),
    queryFn: () => window.runova.devSetup.detect(id as string, { force: true }),
    enabled: id !== null,
    staleTime: 10_000,
    meta: { silentLoading: true },
  });
  const found = detection.data?.state === 'found';

  const update = useQuery({
    queryKey: queryKeys.devSetupUpdateOne(id ?? ''),
    queryFn: async (): Promise<DevUpdateCheck> =>
      (await window.runova.devSetup.updates([id as string]))[id as string] ?? { state: 'unknown' },
    enabled: id !== null && found,
    staleTime: 10 * 60_000,
    meta: { silentLoading: true },
  });

  useEffect(() => {
    if (!id) return;
    return window.runova.devSetup.onEvent((event) => {
      if (event.type !== 'finished' || event.itemId !== id) return;
      setUpgrading(false);
      const name = toolchainName(id);
      if (event.result === 'installed') toast.success(`${name} is up to date.`);
      else if (event.result === 'failed') {
        toast.error(
          event.message ? `${name} did not update: ${event.message}` : `${name} did not update.`,
        );
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.devSetupItem(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.devSetupUpdates });
    });
  }, [id, queryClient]);

  async function upgrade(): Promise<'started' | 'manual'> {
    if (!id) return 'manual';
    const state = await window.runova.devSetup.install({ ids: [id], intent: 'update' });
    if (!state.order.includes(id)) return 'manual';
    setUpgrading(true);
    return 'started';
  }

  const data = detection.data;
  return {
    detection: data,
    installedVersion: data?.state === 'found' ? data.version : null,
    update: update.data,
    upgrading,
    upgrade,
  };
}
