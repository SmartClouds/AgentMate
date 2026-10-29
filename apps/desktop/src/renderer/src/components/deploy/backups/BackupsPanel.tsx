import type { DeployServer } from '@shared/deployTypes';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Archive } from '@/components/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { CoreAccessCard } from '../CoreAccessCard';
import { hasRole, roleLabel } from '../security/format';
import { CARD_BODY, SECURITY_CARD, SecurityCard } from '../security/SecurityCard';
import { useStepUp } from '../security/useStepUp';
import { useTabParam } from '../useTabParam';
import { DestinationsTab } from './DestinationsTab';
import { OverviewTab } from './OverviewTab';
import { PlansTab } from './PlansTab';
import { type RestoreChoice, RestoreTab } from './RestoreTab';
import { SecretTab } from './SecretTab';
import { StoredTab } from './StoredTab';

/** One tab, drawn as the main menu's tinted pill when it is the one shown (as in Security). */
const TAB =
  'h-7 rounded-full border-none px-3 text-xs data-[state=active]:bg-primary/12 data-[state=active]:text-primary data-[state=active]:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.2)] data-[state=inactive]:hover:bg-foreground/[0.06] focus-visible:ring-inset';

const BACKUPS_TABS = ['overview', 'stored', 'plans', 'destinations', 'secret', 'restore'] as const;
export type BackupsTab = (typeof BACKUPS_TABS)[number];

/**
 * A server's Backups section (E28). The core makes the backups, on a schedule that runs with the
 * app closed, encrypts them with a secret key only the user knows and sends them to every
 * destination a plan names; this shows how that stands and changes it. All of it is an Owner's,
 * like the Security area's backups, and the core checks every call again.
 */
export function BackupsPanel({ server }: { server: DeployServer }): React.JSX.Element {
  const [tab, setTab] = useTabParam(BACKUPS_TABS, 'overview');
  const [restoreChoice, setRestoreChoice] = useState<RestoreChoice | null>(null);
  const stepUp = useStepUp(server);
  const access = useQuery({
    queryKey: queryKeys.deployAccess(server.id),
    queryFn: () => window.runova.deploy.access(server.id),
    retry: false,
    staleTime: 30_000,
  });

  if (access.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-8 w-96 max-w-full rounded-full" />
        <div className={cn(SECURITY_CARD, 'space-y-3 p-4')}>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    );
  }

  if (access.data?.state !== 'signed-in') {
    return (
      <div className="space-y-2">
        <p className="px-1 text-sm text-muted-foreground">
          Sign in to see the backups of {server.nickname}.
        </p>
        <CoreAccessCard server={server} />
      </div>
    );
  }

  const roles = access.data.user?.roles;
  if (!hasRole(roles, 'owner')) {
    return (
      <SecurityCard
        icon={<Archive />}
        title="Backups"
        description="A backup holds the whole server, its keys included, so only Owners make, see and restore them."
      >
        <p className={cn(CARD_BODY, 'text-sm text-muted-foreground')}>
          Only an Owner of {server.nickname} can manage its backups. You are signed in as{' '}
          {access.data.user?.userName} ({roleLabel(roles?.[0])}). Ask an Owner if you need a backup
          made or restored.
        </p>
      </SecurityCard>
    );
  }

  const openRestore = (choice: RestoreChoice) => {
    setRestoreChoice(choice);
    setTab('restore');
  };

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as BackupsTab)} className="space-y-2">
      <TabsList
        aria-label="Backups"
        containerClassName="w-fit max-w-full border-b-0"
        className="search-pill mb-0 h-auto w-auto max-w-full gap-0.5 rounded-full p-0.5"
      >
        <TabsTrigger value="overview" className={TAB}>
          Overview
        </TabsTrigger>
        <TabsTrigger value="stored" className={TAB}>
          Backups
        </TabsTrigger>
        <TabsTrigger value="plans" className={TAB}>
          Plans
        </TabsTrigger>
        <TabsTrigger value="destinations" className={TAB}>
          Destinations
        </TabsTrigger>
        <TabsTrigger value="secret" className={TAB}>
          Secret key
        </TabsTrigger>
        <TabsTrigger value="restore" className={TAB}>
          Restore
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="mt-0 space-y-2">
        <OverviewTab server={server} stepUp={stepUp} onOpenTab={setTab} />
      </TabsContent>
      <TabsContent value="stored" className="mt-0">
        <StoredTab server={server} stepUp={stepUp} onRestore={openRestore} />
      </TabsContent>
      <TabsContent value="plans" className="mt-0">
        <PlansTab server={server} onOpenTab={setTab} />
      </TabsContent>
      <TabsContent value="destinations" className="mt-0">
        <DestinationsTab server={server} stepUp={stepUp} />
      </TabsContent>
      <TabsContent value="secret" className="mt-0">
        <SecretTab server={server} stepUp={stepUp} />
      </TabsContent>
      <TabsContent value="restore" className="mt-0">
        <RestoreTab server={server} userName={access.data.user?.userName} initial={restoreChoice} />
      </TabsContent>
      {stepUp.dialog}
    </Tabs>
  );
}
