import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { Link, Server } from '@/components/icons';
import { EmptyState } from '@/components/pageKit';
import { SftpViewSwitch } from '@/components/sftp/SftpViewSwitch';
import { SshFilesView } from '@/components/sftp/SshFilesView';
import { Button } from '@/components/ui/button';
import { usePageHeader } from '@/stores/pageHeaderStore';
import { serverFiles, useSftpStore } from '@/stores/sftpStore';

/** The page's header names the server; the file manager itself is the view. */
function SshFilesPageBody({ serverId }: { serverId: string }): React.JSX.Element {
  const summary = useSftpStore(
    useShallow((state) => {
      const files = serverFiles(state, serverId);
      const known = files.session ?? files.server;
      return known
        ? {
            nickname: known.nickname,
            username: known.username,
            host: known.host,
            port: known.port,
          }
        : null;
    }),
  );

  usePageHeader(
    `Files: ${summary?.nickname ?? 'server'}`,
    summary ? `${summary.username}@${summary.host}:${summary.port}` : undefined,
  );

  // Kept stable, so the view's title row does not redraw with every render of the page.
  const viewActions = useMemo(
    () => <SftpViewSwitch serverId={serverId} variant="page" />,
    [serverId],
  );

  return <SshFilesView serverId={serverId} variant="page" viewActions={viewActions} />;
}

/** `/ssh-files/:serverId`: a saved SSH server as a two-pane SFTP file manager (E25). */
export default function SshFilesPage(): React.JSX.Element {
  const { serverId } = useParams<{ serverId: string }>();
  const navigate = useNavigate();

  if (!serverId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          card
          icon={Server}
          title="No server picked"
          description="Open a saved server's files from Remote, under SSH."
          action={
            <Button onClick={() => navigate('/remote')}>
              <Link /> Open Remote
            </Button>
          }
        />
      </div>
    );
  }
  return <SshFilesPageBody key={serverId} serverId={serverId} />;
}
