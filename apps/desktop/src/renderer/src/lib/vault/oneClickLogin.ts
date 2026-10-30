import type { Project, VaultEntrySummary } from '@runova/core';
import { loginTargetUrl } from '@runova/core';
import type { VaultLoginResult } from '@shared/apiTypes';
import { vaultErrorMessage } from '@shared/vaultErrors';
import { toast } from 'sonner';
import type { VaultLoginChoice } from '@/stores/vaultStore';
import { showCopiedToast } from './clipboardToast';
import { openLoginInWorkspace } from './openInWorkspace';

const REFUSALS: Record<Extract<VaultLoginResult, { ok: false }>['reason'], string> = {
  'not-login': 'Only logins can be opened this way.',
  'no-url': 'Add a website to this login first.',
  'no-guest': 'The Workspace browser tab did not open in time. Try again.',
  unavailable: 'One-click login is not available here.',
};

/** The page a login entry opens, or null when one-click login has nothing to open. */
export function loginUrlOf(entry: VaultEntrySummary): string | null {
  return entry.type === 'login' ? loginTargetUrl(entry.urls) : null;
}

/** The remembered choice, or the login window when its project is gone or not known. */
export function resolveLoginChoice(
  remembered: VaultLoginChoice,
  projects: readonly Project[] | undefined,
): VaultLoginChoice {
  if (remembered.kind !== 'workspace') return remembered;
  return projects?.some((p) => p.id === remembered.projectId) ? remembered : { kind: 'window' };
}

/**
 * Opens a login's website where `choice` says and has it filled in. Problems become a toast, and
 * so does the copied password when the site goes to the default browser.
 */
export async function runOneClickLogin({
  entry,
  choice,
  navigate,
}: {
  entry: VaultEntrySummary;
  choice: VaultLoginChoice;
  navigate: (to: string) => void;
}): Promise<void> {
  const url = loginUrlOf(entry);
  if (!url) {
    toast.error('Could not log in', { description: REFUSALS['no-url'] });
    return;
  }
  try {
    const result =
      choice.kind === 'workspace'
        ? await openLoginInWorkspace({
            entryId: entry.id,
            url,
            projectId: choice.projectId,
            navigate,
          })
        : await window.runova.vault.openLogin(entry.id, choice.kind);
    if (!result.ok) {
      toast.error('Could not log in', { description: REFUSALS[result.reason] });
      return;
    }
    if (choice.kind === 'system' && entry.hasPassword) showCopiedToast('Password', result.clearsAt);
  } catch (error) {
    toast.error('Could not log in', { description: vaultErrorMessage(error) });
  }
}
