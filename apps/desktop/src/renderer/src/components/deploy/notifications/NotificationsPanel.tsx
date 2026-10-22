import type { DeployServer } from '@shared/deployTypes';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { CoreAccessCard } from '../CoreAccessCard';
import { hasRole } from '../security/format';
import { SECURITY_CARD } from '../security/SecurityCard';
import { TelegramCard } from './TelegramCard';

/**
 * A server's Notifications section (E30): where its core sends important events and errors so
 * someone hears about them without the app open. Today that is Telegram. Admins read it and send a
 * test message, Owners change it, and the core checks every call again.
 */
export function NotificationsPanel({
  server,
  onUpdateCore,
}: {
  server: DeployServer;
  /** Opens the core update (the install panel); absent for the DevHost. */
  onUpdateCore?: (() => void) | undefined;
}): React.JSX.Element {
  const access = useQuery({
    queryKey: queryKeys.deployAccess(server.id),
    queryFn: () => window.agentmat.deploy.access(server.id),
    retry: false,
    staleTime: 30_000,
  });

  if (access.isPending) {
    return (
      <div className={cn(SECURITY_CARD, 'space-y-3 p-4')} aria-busy="true">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
      </div>
    );
  }

  if (access.data?.state !== 'signed-in') {
    return (
      <div className="space-y-2">
        <p className="px-1 text-sm text-muted-foreground">
          Sign in to choose where {server.nickname} sends its alerts.
        </p>
        <CoreAccessCard server={server} />
      </div>
    );
  }

  const roles = access.data.user?.roles;
  if (!hasRole(roles, 'admin')) {
    return (
      <p className="px-1 text-sm text-muted-foreground">
        Admins and Owners choose where {server.nickname} sends its alerts. Ask one of them to add
        you to the Telegram chat.
      </p>
    );
  }

  return (
    <TelegramCard server={server} owner={hasRole(roles, 'owner')} onUpdateCore={onUpdateCore} />
  );
}
