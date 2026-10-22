import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Archive, Docker, HardDrive, Lock } from '@/components/icons';
import { EmptyState, GLASS_CARD, LoadFailure, Notice } from '@/components/pageKit';
import { SshFilesView } from '@/components/sftp/SshFilesView';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { allContainers } from '@/lib/deploy/containers/list';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { CoreAccessCard } from '../CoreAccessCard';
import { hasRole, isRole, withArticle } from '../security/format';
import {
  type FilesChoice,
  type FilesSource,
  fileManagerId,
  filesChoice,
  filesParams,
} from './params';

/**
 * A server's Files section (E27): the E25 file manager, this computer on the left and the server
 * on the right, pointed at the server's own disk over SFTP, a container's file system or a
 * Docker volume. The choice lives in the page address. Containers and volumes go through the
 * server core and are for Admins, like the console; the server disk only needs the SSH login.
 */

const SOURCE_OPTIONS: Record<FilesSource, ComboboxOption> = {
  server: {
    value: 'server',
    label: 'Server disk',
    icon: <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
  },
  container: {
    value: 'container',
    label: 'Container',
    icon: <Docker className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
  },
  volume: {
    value: 'volume',
    label: 'Volume',
    icon: <Archive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
  },
};

/** The section's place while it finds out what it can show: one card shimmers. */
function FilesSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label="Loading the files"
      className={cn(GLASS_CARD, 'flex min-h-0 flex-1 gap-2 p-2')}
    >
      {[0, 1].map((pane) => (
        <div key={pane} className="flex flex-1 flex-col gap-2 p-2">
          <Skeleton className="h-7 w-40 rounded-full" />
          {Array.from({ length: 6 }, (_, row) => (
            <Skeleton key={row} className="h-6 w-full rounded-md" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** "an Operator", or plain words when the core sent a role this app does not know. */
function roleWords(roles: readonly string[] | undefined): string {
  const known = (roles ?? []).find(isRole);
  return known ? withArticle(known) : 'a user without a role here';
}

export function ServerFilesPanel({ server }: { server: DeployServer }): React.JSX.Element {
  const serverId = server.id;
  const [params, setParams] = useSearchParams();
  // The DevHost has no SSH, so there is no disk of its own to browse.
  const sshDisk = !server.dev;
  const choice = filesChoice(params, { sshDisk });
  const docker = choice.source !== 'server';

  const choose = (next: FilesChoice) => setParams(filesParams(serverId, next), { replace: true });

  const access = useQuery({
    queryKey: queryKeys.deployAccess(serverId),
    queryFn: () => window.agentmat.deploy.access(serverId),
    enabled: docker,
    retry: false,
    staleTime: 30_000,
  });
  const signedIn = access.data?.state === 'signed-in';
  const roles = access.data?.user?.roles;
  const admin = hasRole(roles, 'admin');
  const status = useQuery({
    queryKey: queryKeys.deployDockerStatus(serverId),
    queryFn: () => window.agentmat.deployDocker.status(serverId),
    enabled: docker && signedIn && admin,
    retry: false,
  });
  const ready =
    docker && signedIn && admin && status.data?.installed === true && status.data.running;
  const containers = useQuery({
    queryKey: queryKeys.deployContainers(serverId),
    queryFn: () => window.agentmat.deployDocker.listContainers(serverId),
    enabled: ready && choice.source === 'container',
    retry: false,
  });
  const volumes = useQuery({
    queryKey: queryKeys.deployVolumes(serverId),
    queryFn: () => window.agentmat.deployDocker.listVolumes(serverId),
    enabled: ready && choice.source === 'volume',
    retry: false,
  });
  const list = choice.source === 'container' ? containers : volumes;

  const sourceOptions = useMemo(
    () =>
      (sshDisk
        ? (['server', 'container', 'volume'] as const)
        : (['container', 'volume'] as const)
      ).map((source) => SOURCE_OPTIONS[source]),
    [sshDisk],
  );
  const targetOptions = useMemo<ComboboxOption[]>(() => {
    if (choice.source === 'container') {
      return allContainers(containers.data)
        .map((one) => ({
          value: one.name,
          label: `${one.name} (${one.state})`,
          keywords: [one.image],
        }))
        .sort((a, b) => a.value.localeCompare(b.value));
    }
    if (choice.source === 'volume') {
      return (volumes.data ?? [])
        .map((one) => ({ value: one.name, label: one.name }))
        .sort((a, b) => a.value.localeCompare(b.value));
    }
    return [];
  }, [choice.source, containers.data, volumes.data]);

  const noun = choice.source === 'volume' ? 'volume' : 'container';
  const listed = ready && list.data !== undefined && targetOptions.length > 0;
  const id = fileManagerId(serverId, choice);

  let body: React.ReactNode;
  if (!docker) {
    body = <FilesView id={serverId} />;
  } else if (access.isPending) {
    body = <FilesSkeleton />;
  } else if (!signedIn) {
    body = (
      <div className="flex flex-col gap-2">
        <EmptyState
          card
          size="sm"
          icon={Docker}
          title="Not signed in"
          description={`Sign in to ${server.nickname} to browse the files in its containers and volumes.`}
        />
        <CoreAccessCard server={server} />
      </div>
    );
  } else if (!admin) {
    body = (
      <EmptyState
        card
        size="sm"
        icon={Lock}
        title="Files in containers and volumes are for Admins"
        description={`They can read and change everything inside. You are signed in as ${roleWords(roles)}.`}
      />
    );
  } else if (status.isPending) {
    body = <FilesSkeleton />;
  } else if (status.error) {
    body = (
      <LoadFailure
        message={`Could not find out about Docker: ${coreErrorMessage(status.error)}`}
        retry={() => void status.refetch()}
      />
    );
  } else if (!ready) {
    const installed = status.data?.installed === true;
    body = (
      <EmptyState
        card
        size="sm"
        icon={Docker}
        title={
          installed
            ? `Docker is not running on ${server.nickname}`
            : `Docker is not installed on ${server.nickname}`
        }
        description={
          installed
            ? 'Start it from the Containers section to browse containers and volumes.'
            : 'Install it from the Containers section to run containers and browse their files.'
        }
        action={
          <Button
            size="sm"
            variant="soft"
            onClick={() => setParams({ server: serverId, view: 'containers' }, { replace: true })}
          >
            <Docker className="h-3.5 w-3.5" /> Open Containers
          </Button>
        }
      />
    );
  } else if (list.isPending) {
    body = <FilesSkeleton />;
  } else if (list.error) {
    body = (
      <LoadFailure
        message={`Could not list the ${noun}s: ${coreErrorMessage(list.error)}`}
        retry={() => void list.refetch()}
      />
    );
  } else if (targetOptions.length === 0) {
    body = (
      <EmptyState
        card
        size="sm"
        icon={choice.source === 'volume' ? Archive : Docker}
        title={`No ${noun}s on ${server.nickname}`}
        description={
          choice.source === 'volume'
            ? 'A volume shows up here once a container or a compose app makes one.'
            : 'A container shows up here once an app or a compose stack runs one.'
        }
      />
    );
  } else if (!choice.target) {
    body = (
      <EmptyState
        card
        size="sm"
        icon={choice.source === 'volume' ? Archive : Docker}
        title={`Choose a ${noun}`}
        description={
          choice.source === 'volume'
            ? 'Pick one above to browse its files. A volume is shown from its root.'
            : 'Pick one above to browse its files. A stopped container still lists, uploads and downloads, but renaming, deleting and editing need it running.'
        }
      />
    );
  } else if (!targetOptions.some((option) => option.value === choice.target) || !id) {
    body = (
      <Notice tone="warning">
        {`${choice.target} is not on ${server.nickname} anymore. Pick another ${noun}.`}
      </Notice>
    );
  } else {
    body = <FilesView id={id} />;
  }

  return (
    <div className="flex min-h-[32rem] flex-1 flex-col gap-2">
      <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-2 px-2.5 py-2')}>
        <Combobox
          ariaLabel="Source"
          options={sourceOptions}
          value={choice.source}
          onChange={(value) => {
            const source = value as FilesSource;
            if (source !== choice.source) choose({ source, target: null });
          }}
          searchable={false}
          className="w-44"
        />
        {listed ? (
          <Combobox
            ariaLabel={choice.source === 'volume' ? 'Volume' : 'Container'}
            options={targetOptions}
            value={choice.target ?? ''}
            onChange={(target) => choose({ source: choice.source, target: target || null })}
            placeholder={`Pick a ${noun}`}
            searchPlaceholder={`Find a ${noun}`}
            emptyText={`No ${noun} by that name.`}
            className="w-72 max-w-full"
          />
        ) : null}
      </div>
      {body}
    </div>
  );
}

/** The file manager itself, drawn for this section. A new target is a new view. */
function FilesView({ id }: { id: string }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SshFilesView key={id} serverId={id} variant="embedded" />
    </div>
  );
}
