import type { VaultLoginResult } from '@shared/apiTypes';
import { browserRuntime } from '@/lib/browser/browserRuntime';
import { useWorkspaceStore } from '@/stores/workspaceStore';

const POLL_MS = 150;

/**
 * One-click login into a Workspace browser tab: opens the site in a new tab of the project, shows
 * it, waits for its page to attach and then asks main to fill it. The password goes from main to
 * the page and never through here.
 */
export async function openLoginInWorkspace({
  entryId,
  url,
  projectId,
  navigate,
  runtime = browserRuntime,
  timeoutMs = 20_000,
}: {
  entryId: string;
  url: string;
  projectId: string;
  navigate: (to: string) => void;
  /** Only the tab's page id is read, so tests can stand in for the real runtime. */
  runtime?: { state: (tabId: string) => { webContentsId: number | null } };
  timeoutMs?: number;
}): Promise<VaultLoginResult> {
  const workspace = useWorkspaceStore.getState();
  workspace.openProject(projectId);
  const tabId = workspace.openBrowser(projectId, { url });
  navigate(`/workspace/${projectId}?session=${encodeURIComponent(tabId)}`);

  // The tab's webview only exists once the Workspace has drawn the tab, so this polls for it.
  const webContentsId = await new Promise<number | null>((resolve) => {
    const started = Date.now();
    const check = (): void => {
      const id = runtime.state(tabId).webContentsId;
      if (id !== null) resolve(id);
      else if (Date.now() - started >= timeoutMs) resolve(null);
      else setTimeout(check, POLL_MS);
    };
    check();
  });
  if (webContentsId === null) return { ok: false, reason: 'no-guest' };
  return window.runova.vault.fillGuest(entryId, webContentsId);
}
