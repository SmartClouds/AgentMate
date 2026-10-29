import type { DockerHubRepository, DockerHubTag } from '@shared/apiTypes';
import { coreErrorMessage } from '@shared/coreErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { RegistryCredentialDialog } from '@/components/deploy/registries/RegistryCredentialDialog';
import { Docker, Lock, Package, RefreshCw, Search } from '@/components/icons';
import { Chip, EmptyState, GLASS_CARD, LoadFailure, SearchPill } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { DockerHubRepoRow } from './DockerHubRepoRow';
import { hubReference, localReferences } from './images';

function matches(repository: DockerHubRepository, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    repository.name.toLowerCase().includes(q) || repository.description.toLowerCase().includes(q)
  );
}

function RepositorySkeleton(): React.JSX.Element {
  return (
    <div
      className={cn(GLASS_CARD, 'settings-rows')}
      role="status"
      aria-label="Loading repositories"
    >
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3.5 py-3">
          <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The signed-in Docker Hub account's repositories, with each one's tags and a way to pull a tag
 * to this machine. The account is the Docker Hub sign-in deploys use, added or replaced here
 * with the same form as under Deploy, so the two never disagree about who is signed in.
 */
export function DockerHubView(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [signInOpen, setSignInOpen] = useState(false);
  const [openRepos, setOpenRepos] = useState<Set<string>>(new Set());
  const [pulling, setPulling] = useState<Set<string>>(new Set());

  const statusQuery = useQuery({
    queryKey: queryKeys.dockerHubStatus,
    queryFn: () => window.runova.dockerHub.status(),
  });
  const signedIn = statusQuery.data?.state === 'signedIn';
  const reposQuery = useQuery({
    queryKey: queryKeys.dockerHubRepositories,
    queryFn: () => window.runova.dockerHub.repositories(),
    enabled: signedIn,
    staleTime: 60_000,
    retry: false,
  });
  const localQuery = useQuery({
    queryKey: queryKeys.dockerImages,
    queryFn: () => window.runova.docker.listImages(),
    enabled: signedIn,
    meta: { silentLoading: true },
  });
  const localRefs = localReferences(localQuery.data ?? []);

  function signInSaved(): void {
    setSignInOpen(false);
    // Everything Hub showed belonged to the old sign-in, and Deploy lists the sign-ins too.
    void queryClient.invalidateQueries({ queryKey: ['docker-hub'] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployRegistries });
  }

  function toggle(key: string): void {
    setOpenRepos((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function pull(repository: DockerHubRepository, tag: DockerHubTag): Promise<void> {
    const ref = hubReference(repository.namespace, repository.name, tag.name);
    setPulling((current) => new Set(current).add(ref));
    try {
      const result = await window.runova.dockerHub.pull({
        namespace: repository.namespace,
        name: repository.name,
        tag: tag.name,
        isPrivate: repository.isPrivate,
      });
      if (result.ok) {
        toast.success(`Pulled ${ref}.`);
        void queryClient.invalidateQueries({ queryKey: queryKeys.dockerImages });
      } else {
        toast.error(result.error ?? `Could not pull ${ref}.`);
      }
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setPulling((current) => {
        const next = new Set(current);
        next.delete(ref);
        return next;
      });
    }
  }

  const dialog = (
    <RegistryCredentialDialog
      kind={signInOpen ? 'dockerhub' : null}
      onClose={() => setSignInOpen(false)}
      onSaved={signInSaved}
    />
  );

  if (statusQuery.isPending) return <RepositorySkeleton />;

  if (statusQuery.error) {
    return (
      <LoadFailure
        message={coreErrorMessage(statusQuery.error)}
        retry={() => void statusQuery.refetch()}
      />
    );
  }

  if (statusQuery.data.state === 'signedOut') {
    return (
      <>
        <EmptyState
          card
          size="lg"
          icon={Docker}
          title="Connect your Docker Hub account"
          description="See your repositories and pull their tags to this machine. Deploys use the same sign-in, sealed here like your server passwords."
          action={<Button onClick={() => setSignInOpen(true)}>Sign in to Docker Hub</Button>}
        />
        {dialog}
      </>
    );
  }

  if (statusQuery.data.state === 'locked') {
    return (
      <EmptyState
        card
        size="lg"
        icon={Lock}
        title="Your Docker Hub sign-in is locked"
        description="Unlock the Servers passkey to use the Docker Hub sign-in saved on this computer."
      />
    );
  }

  const search = query.trim();
  const repositories = reposQuery.data ?? [];
  const visible = repositories.filter((repository) => matches(repository, search));

  return (
    <div className="flex flex-col gap-2">
      <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-2 px-2.5 py-2')}>
        <SearchPill
          label="Search repositories"
          placeholder="Search repositories"
          value={query}
          onValueChange={setQuery}
          className="w-full min-w-48 max-w-xs flex-1"
        />
        <Chip tone="success" dot className="h-6 px-2.5">
          Signed in as <span className="font-semibold">{statusQuery.data.username}</span>
        </Chip>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={() => setSignInOpen(true)}>
            Change sign-in
          </Button>
          <Button
            variant="soft"
            disabled={reposQuery.isFetching}
            aria-busy={reposQuery.isFetching}
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['docker-hub'] })}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', reposQuery.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {reposQuery.isPending ? (
        <RepositorySkeleton />
      ) : reposQuery.error ? (
        <LoadFailure
          message={coreErrorMessage(reposQuery.error)}
          retry={() => void reposQuery.refetch()}
        />
      ) : repositories.length === 0 ? (
        <EmptyState
          card
          size="lg"
          icon={Package}
          title="No repositories yet"
          description={`Images you push to ${statusQuery.data.username ?? 'your account'} on Docker Hub show up here.`}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          card
          size="sm"
          icon={Search}
          title="Nothing found"
          description={`No repositories match "${search}".`}
        />
      ) : (
        <ul aria-label="Repositories" className={cn(GLASS_CARD, 'settings-rows overflow-hidden')}>
          {visible.map((repository) => {
            const key = `${repository.namespace}/${repository.name}`;
            return (
              <DockerHubRepoRow
                key={key}
                repository={repository}
                open={openRepos.has(key)}
                localRefs={localRefs}
                pulling={pulling}
                onToggle={() => toggle(key)}
                onPull={(tag) => void pull(repository, tag)}
              />
            );
          })}
        </ul>
      )}
      {dialog}
    </div>
  );
}
