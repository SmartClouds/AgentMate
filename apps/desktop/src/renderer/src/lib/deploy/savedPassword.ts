import { coreErrorMessage } from '@shared/coreErrors';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The account password this computer was asked to remember for a server (sealed in the main
 * process, never sent back here). The core's step-up uses it before the user is asked.
 */

/**
 * Confirms with the remembered password. Resolves to when the core's ten minutes end, or null
 * when there is nothing to use (none saved, the vault is locked, or the core turned it down), so
 * the caller asks for the password the usual way.
 */
export async function stepUpWithSavedPassword(serverId: string): Promise<number | null> {
  try {
    const confirmed = await window.runova.deploy.stepUpSaved(serverId);
    return confirmed?.stepUpUntilUnixMs ?? null;
  } catch {
    return null;
  }
}

/**
 * Remembers a password the core just accepted. It runs after the change it confirmed went
 * through, so a failure here only says so: it never undoes that.
 */
export async function rememberPassword(
  queryClient: QueryClient,
  serverId: string,
  password: string,
): Promise<void> {
  try {
    await window.runova.deploy.rememberPassword({ serverId, password });
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployAccess(serverId) });
  } catch (error) {
    toast.error(`Your password was not remembered. ${coreErrorMessage(error)}`);
  }
}
