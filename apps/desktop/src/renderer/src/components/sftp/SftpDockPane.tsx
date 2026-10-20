import { useMemo } from 'react';
import { useMatch } from 'react-router-dom';
import { FolderOpen } from '@/components/icons';
import { EmptyState } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { useTerminalStore } from '@/stores/terminalStore';
import { SftpViewSwitch } from './SftpViewSwitch';
import { SshFilesView } from './SshFilesView';

export interface SftpDockPaneProps {
  serverId: string;
  /**
   * The drawer is open and this is its tab on screen. The pane stays mounted otherwise (the
   * drawer never unmounts its tabs), so this is what says whether the user can see it.
   */
  active: boolean;
}

/**
 * A server's file manager as a tab of the terminal drawer (E25 F6), so it stays at hand on
 * every page. It is a view of the same session as the page and the pop-out window.
 *
 * It counts as shown only while it is on screen: a transfer that finishes with the drawer shut
 * or another tab in front still gets its "finished" toast. While the page of the same server is
 * open, the tab steps aside with a note rather than draw a second copy in this window.
 */
export function SftpDockPane({ serverId, active }: SftpDockPaneProps): React.JSX.Element {
  const onPage = useMatch('/ssh-files/:serverId')?.params.serverId === serverId;
  // Kept the same across renders, so the view does not redraw its title row for nothing.
  const viewActions = useMemo(
    () => <SftpViewSwitch serverId={serverId} variant="dock" />,
    [serverId],
  );

  if (onPage) {
    return (
      <div
        data-sftp-dock={serverId}
        className={active ? 'absolute inset-0 flex items-center justify-center' : 'hidden'}
      >
        <EmptyState
          size="sm"
          icon={FolderOpen}
          title="Shown on the page"
          description="These files are open on the page above, so they are not drawn here twice."
          action={
            <Button
              size="sm"
              variant="soft"
              onClick={() => {
                const terminal = useTerminalStore.getState();
                terminal.setMaximized(false);
                terminal.closeDrawer();
              }}
            >
              Show the page
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div data-sftp-dock={serverId} className={active ? 'absolute inset-0 flex' : 'hidden'}>
      <SshFilesView
        key={serverId}
        serverId={serverId}
        variant="dock"
        trackVisibility={active}
        viewActions={viewActions}
      />
    </div>
  );
}
