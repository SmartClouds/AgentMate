import type { SftpPopOutView } from '@shared/sftpTypes';
import { type NavigateFunction, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { ArrowLeft, Expand, ExternalLink, TerminalSquare } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { sftpBridge } from '@/lib/sftp/bridge';
import { closeSftpDock, openSftpDock } from '@/lib/sftp/dock';
import { sftpProblem } from '@/lib/sftp/messages';
import { serverFiles, useSftpStore } from '@/stores/sftpStore';

export type SftpViewVariant = 'page' | 'dock' | 'window';

export interface SftpViewSwitchProps {
  serverId: string;
  /** Where this copy of the file manager is drawn, which decides where it can go next. */
  variant: SftpViewVariant;
}

/** What the switch reads of Chromium's Navigation API (`window.navigation`). */
interface HistoryEntryLike {
  url: string | null;
  index: number;
}
interface NavigationLike {
  currentEntry: HistoryEntryLike | null;
  entries(): HistoryEntryLike[];
}

/**
 * The app route (`/docker`, query left out) of the history entry before this one, or null when
 * it cannot be known: the first entry, an entry of another page, or an engine without the
 * Navigation API. The router itself only knows where it is, not where it was.
 */
export function previousRoute(): string | null {
  const navigation = (window as unknown as { navigation?: NavigationLike }).navigation;
  const current = navigation?.currentEntry;
  if (!navigation || !current || current.index < 1) return null;
  const before = navigation.entries()[current.index - 1];
  if (!before?.url || !URL.canParse(before.url)) return null;
  const url = new URL(before.url);
  if (url.origin !== window.location.origin || url.pathname !== window.location.pathname) {
    return null;
  }
  return url.hash.replace(/^#/, '').split('?')[0] || '/';
}

const FILES_PAGE = '/ssh-files/';

/** Whether `route` is the `/ssh-files/<serverId>` page of this server. */
export function isFilesPageOf(route: string, serverId: string): boolean {
  if (!route.startsWith(FILES_PAGE)) return false;
  try {
    return decodeURIComponent(route.slice(FILES_PAGE.length).replace(/\/+$/, '')) === serverId;
  } catch {
    return false;
  }
}

/**
 * Leaves a server's file manager page once the file manager went somewhere else (the panel or
 * its own window). Back to where the user was before opening it, since that is what they were
 * working on. Remote, where the servers are, when going back would land on this same page again
 * (the status bar and the drawer push it a second time) or where it would land cannot be known.
 */
export function leaveFilesPage(navigate: NavigateFunction, serverId: string): void {
  const before = previousRoute();
  if (before === null || isFilesPageOf(before, serverId)) void navigate('/remote');
  else void navigate(-1);
}

function SwitchButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label} wrapTrigger={disabled}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="shrink-0"
      >
        {children}
      </Button>
    </SimpleTooltip>
  );
}

/**
 * Moves the file manager between the page, the bottom panel and a window of its own (E25). It
 * sits in the server pane's title row next to Disconnect. Every view shows the same session, so
 * moving never touches the transfers.
 */
export function SftpViewSwitch({ serverId, variant }: SftpViewSwitchProps): React.JSX.Element {
  const navigate = useNavigate();
  const { sessionId, nickname } = useSftpStore(
    useShallow((state) => {
      const files = serverFiles(state, serverId);
      return {
        sessionId: files.session?.sessionId ?? null,
        nickname: files.session?.nickname ?? files.server?.nickname ?? 'server',
      };
    }),
  );

  async function popOut(): Promise<void> {
    if (!sessionId) return;
    // Read at click time: the window opens at the folders the panes show now.
    const { remote, local } = serverFiles(useSftpStore.getState(), serverId);
    const view: SftpPopOutView = {};
    if (remote.path) view.remotePath = remote.path;
    if (local.path) view.localPath = local.path;
    try {
      await sftpBridge().popOut(sessionId, view);
    } catch (error) {
      toast.error(`Could not open ${nickname} in a new window: ${sftpProblem(error)}`);
      return;
    }
    // The window has it now, so this one is free for the rest of the app.
    if (variant === 'page') leaveFilesPage(navigate, serverId);
    else closeSftpDock(serverId);
  }

  function showInPanel(): void {
    try {
      openSftpDock(serverId, nickname);
    } catch (error) {
      toast.error(`Could not show ${nickname} in the panel: ${sftpProblem(error)}`);
      return;
    }
    leaveFilesPage(navigate, serverId);
  }

  function openAsPage(): void {
    void navigate(`/ssh-files/${encodeURIComponent(serverId)}`);
    closeSftpDock(serverId);
  }

  async function backToMain(): Promise<void> {
    try {
      await sftpBridge().backToMain();
    } catch (error) {
      toast.error(`Could not go back to the main window: ${sftpProblem(error)}`);
    }
  }

  const newWindow = (
    <SwitchButton label="Open in a new window" disabled={!sessionId} onClick={() => void popOut()}>
      <ExternalLink />
    </SwitchButton>
  );

  if (variant === 'window') {
    return (
      <SwitchButton label="Back to main window" onClick={() => void backToMain()}>
        <ArrowLeft />
      </SwitchButton>
    );
  }
  if (variant === 'dock') {
    return (
      <>
        <SwitchButton label="Open as page" onClick={openAsPage}>
          <Expand />
        </SwitchButton>
        {newWindow}
      </>
    );
  }
  return (
    <>
      <SwitchButton label="Show in panel" onClick={showInPanel}>
        <TerminalSquare />
      </SwitchButton>
      {newWindow}
    </>
  );
}
