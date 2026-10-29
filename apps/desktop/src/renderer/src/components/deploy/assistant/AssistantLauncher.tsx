import type { DeployServer } from '@shared/deployTypes';
import { useEffect } from 'react';
import { Robot } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useDeployAssistantStore } from '@/stores/deployAssistantStore';
import { AssistantDrawer } from './AssistantDrawer';
import { useDeployAssistantEvents } from './hooks';

/**
 * The Deploy AI on every screen of a server (E09 T8). The page tells the top bar which server it
 * shows, so the Deploy AI button there (next to the terminal's) opens the drawer on it.
 */
export function AssistantLauncher({ server }: { server: DeployServer }): React.JSX.Element {
  useDeployAssistantEvents();
  const setPageServer = useDeployAssistantStore((state) => state.setPageServer);

  useEffect(() => {
    setPageServer(server.id);
    return () => {
      // Another server's page may have taken over already, when the user switched servers.
      if (useDeployAssistantStore.getState().pageServerId === server.id) setPageServer(null);
    };
  }, [server.id, setPageServer]);

  return <AssistantDrawer server={server} />;
}

/**
 * The top bar's Deploy AI button, shown while a Deploy server's page is open. It toggles the
 * drawer like the terminal button next to it toggles the terminal, and a run that waits for the
 * user says so with the same amber dot (only while the drawer is closed, since an open drawer
 * already shows what waits).
 */
export function AssistantTopBarButton(): React.JSX.Element | null {
  const serverId = useDeployAssistantStore((state) => state.pageServerId);
  const openServerId = useDeployAssistantStore((state) => state.openServerId);
  const open = useDeployAssistantStore((state) => state.open);
  const close = useDeployAssistantStore((state) => state.close);
  const phase = useDeployAssistantStore((state) =>
    serverId ? state.runs[serverId]?.progress?.phase : undefined,
  );
  if (!serverId) return null;
  const isOpen = openServerId === serverId;
  const waiting = !isOpen && (phase === 'proposed' || phase === 'needs-input');

  return (
    <SimpleTooltip label={waiting ? 'The Deploy AI is waiting for you' : 'Deploy AI'}>
      <Button
        variant={isOpen ? 'soft' : 'ghost'}
        size="icon"
        aria-pressed={isOpen}
        aria-label={waiting ? 'Deploy AI, waiting for you' : 'Deploy AI'}
        onClick={() => (isOpen ? close() : open(serverId))}
        className="relative"
      >
        <Robot className="h-4 w-4" />
        {waiting && (
          <span className="absolute right-1 top-1 h-2 w-2 animate-pulse rounded-full bg-amber-400 shadow-[0_0_6px_var(--color-amber-400)]" />
        )}
      </Button>
    </SimpleTooltip>
  );
}
