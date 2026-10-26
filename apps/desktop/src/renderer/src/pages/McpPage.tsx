import type { McpRepositorySourceType, McpServer } from '@runova/core';
import { BOWORA_MCP_REPOSITORY_ID } from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  CircleCheck,
  FolderOpen,
  GitBranch,
  Globe,
  LayoutDashboard,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Spinner,
  Tag,
  Trash2,
  TriangleAlert,
} from '@/components/icons';
import {
  CARD_GRID,
  CatalogCardShimmer,
  CatalogSplit,
  Chip,
  EmptyState,
  FilterChip,
  FOOTER_HAIRLINE,
  GLASS_CARD,
  RepositorySourceIcon,
  SECTION_HEADING,
  SearchPill,
  SideNavRow,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { usePageHeader } from '@/stores/pageHeaderStore';

const SOURCE_TYPES: { value: McpRepositorySourceType; label: string }[] = [
  { value: 'url', label: 'URL (JSON index)' },
  { value: 'git', label: 'Git repository' },
  { value: 'local-folder', label: 'Local folder' },
];

const EMPTY_SERVERS: McpServer[] = [];

/** How a repository's source reads under its name in the catalog header. */
const SOURCE_LABEL: Record<McpRepositorySourceType, string> = {
  bundled: 'Bundled with Runova',
  url: 'JSON index',
  git: 'Git repository',
  'local-folder': 'Local folder',
};

function monogramLetter(name: string): string {
  const match = name.match(/[A-Za-z0-9]/);
  return (match?.[0] ?? '?').toUpperCase();
}

const McpServerCard = memo(function McpServerCard({
  server,
  isInstalled,
  canInstall,
  isInstalling,
  isRemoving,
  showCategory,
  onInstall,
  onRemove,
}: {
  server: McpServer;
  isInstalled: boolean;
  canInstall: boolean;
  isInstalling: boolean;
  isRemoving: boolean;
  showCategory: boolean;
  onInstall: (server: McpServer) => void;
  onRemove: (server: McpServer) => void;
}): React.JSX.Element {
  const canAutoInstall =
    server.config.transport === 'stdio' ? !!server.config.command : !!server.config.url;
  const installDisabled = !canInstall || isInstalling;

  return (
    <article
      aria-label={server.name}
      className={cn(
        GLASS_CARD,
        // The edge is an inset ring, because the global border colour wins over a tinted border.
        'flex flex-col ring-1 ring-inset transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 motion-reduce:hover:translate-y-0',
        isInstalled
          ? 'ring-success/35 hover:ring-success/55'
          : 'ring-transparent hover:ring-primary/30',
      )}
    >
      <div className="flex flex-1 flex-col gap-2.5 p-4 pb-3">
        <div className="flex items-start gap-3">
          <div
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 font-semibold text-primary"
          >
            {monogramLetter(server.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold leading-tight">
                <span className="truncate">{server.name}</span>
                {server.official && (
                  <SimpleTooltip label="Official, maintained by the vendor or organization behind this integration">
                    <CircleCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
                  </SimpleTooltip>
                )}
              </h3>
              {isInstalled && (
                <Chip tone="success" dot>
                  Installed
                </Chip>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {server.author}
              {server.version && server.version !== 'latest' ? ` · v${server.version}` : ''}
              {` · ${server.config.transport}`}
            </p>
          </div>
        </div>
        <p className="line-clamp-2 text-sm text-muted-foreground">{server.description}</p>
        {(showCategory || !canAutoInstall) && (
          <div className="mt-auto flex flex-wrap items-center gap-1.5">
            {showCategory && <Chip>{server.category}</Chip>}
            {!canAutoInstall && <Chip tone="warning">Manual setup</Chip>}
          </div>
        )}
      </div>
      <div className={cn('flex items-center gap-2 px-3 py-2.5', FOOTER_HAIRLINE)}>
        {isInstalled ? (
          <Button variant="soft" size="sm" disabled={isRemoving} onClick={() => onRemove(server)}>
            {isRemoving ? <Spinner className="animate-spin" /> : <Trash2 />}
            {isRemoving ? 'Removing…' : 'Remove'}
          </Button>
        ) : canAutoInstall ? (
          <SimpleTooltip
            label={canInstall ? undefined : 'Choose a project first'}
            wrapTrigger={installDisabled}
          >
            <Button size="sm" disabled={installDisabled} onClick={() => onInstall(server)}>
              {isInstalling ? <Spinner className="animate-spin" /> : <Plug />}
              {isInstalling ? 'Installing…' : 'Install'}
            </Button>
          </SimpleTooltip>
        ) : (
          <SimpleTooltip
            label="No install command available yet. See the server's docs to set it up manually."
            wrapTrigger
          >
            <Button size="sm" disabled>
              <Plug /> Install
            </Button>
          </SimpleTooltip>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {server.websiteUrl && (
            <SimpleTooltip label="Website">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Open ${server.name} website`}
                onClick={() => void window.runova.shell.openExternal(server.websiteUrl!)}
              >
                <Globe className="h-3.5 w-3.5" />
              </Button>
            </SimpleTooltip>
          )}
          {server.repositoryUrl && (
            <SimpleTooltip label="Source repository">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Open ${server.name} source repository`}
                onClick={() => void window.runova.shell.openExternal(server.repositoryUrl!)}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </Button>
            </SimpleTooltip>
          )}
        </div>
      </div>
    </article>
  );
});

export default function McpPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const [selectedProjectId, setSelectedProjectId] = useState(searchParams.get('projectId') ?? '');
  const [selectedRepoId, setSelectedRepoId] = useState<string>('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [onlyOfficial, setOnlyOfficial] = useState(false);
  const [onlyInstalled, setOnlyInstalled] = useState(false);
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [repoName, setRepoName] = useState('');
  const [repoSourceType, setRepoSourceType] = useState<McpRepositorySourceType>('local-folder');
  const [repoSource, setRepoSource] = useState('');
  const [envServer, setEnvServer] = useState<McpServer | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  });
  const reposQuery = useQuery({
    queryKey: queryKeys.mcpRepositories,
    queryFn: () => window.runova.mcp.listRepositories(),
  });

  useEffect(() => {
    if (!selectedRepoId && reposQuery.data && reposQuery.data.length > 0) {
      setSelectedRepoId(reposQuery.data[0].id);
      setCategoryFilter('all');
    }
  }, [reposQuery.data, selectedRepoId]);

  const repoIndexQuery = useQuery({
    queryKey: queryKeys.mcpRepositoryIndex(selectedRepoId),
    queryFn: () => window.runova.mcp.getRepositoryIndex(selectedRepoId),
    enabled: !!selectedRepoId,
  });

  const installedServersQuery = useQuery({
    queryKey: queryKeys.installedMcpServers(selectedProjectId),
    queryFn: () => window.runova.mcp.listInstalled(selectedProjectId),
    enabled: !!selectedProjectId,
  });

  const addRepoMutation = useMutation({
    mutationFn: () =>
      window.runova.mcp.addRepository({
        name: repoName,
        sourceType: repoSourceType,
        source: repoSource,
      }),
    onSuccess: () => {
      toast.success('Repository added.');
      setAddRepoOpen(false);
      setRepoName('');
      setRepoSource('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcpRepositories });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const removeRepoMutation = useMutation({
    mutationFn: (id: string) => window.runova.mcp.removeRepository(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcpRepositories });
      setSelectedRepoId('');
      setCategoryFilter('all');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const refreshRepoMutation = useMutation({
    mutationFn: (id: string) => window.runova.mcp.refreshRepository(id),
    onSuccess: () => {
      toast.success('Repository refreshed.');
      void queryClient.invalidateQueries({
        queryKey: queryKeys.mcpRepositoryIndex(selectedRepoId),
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const installMutation = useMutation({
    mutationFn: (params: { serverId: string; env?: Record<string, string> }) =>
      window.runova.mcp.install({
        projectId: selectedProjectId,
        repositoryId: selectedRepoId,
        serverId: params.serverId,
        env: params.env,
      }),
    onSuccess: () => {
      toast.success('MCP server installed.');
      void queryClient.invalidateQueries({
        queryKey: queryKeys.installedMcpServers(selectedProjectId),
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const removeServerMutation = useMutation({
    mutationFn: (serverId: string) =>
      window.runova.mcp.remove({ projectId: selectedProjectId, serverId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.installedMcpServers(selectedProjectId),
      });
    },
  });

  const installedIds = useMemo(
    () => new Set(installedServersQuery.data?.map((s) => s.serverId) ?? []),
    [installedServersQuery.data],
  );

  const allServers = repoIndexQuery.data?.servers ?? EMPTY_SERVERS;

  const categories = useMemo(() => {
    return [...new Set(allServers.map((s) => s.category))].sort((a, b) => a.localeCompare(b));
  }, [allServers]);

  const installedInCatalog = useMemo(
    () => allServers.filter((s) => installedIds.has(s.id)).length,
    [allServers, installedIds],
  );

  const filteredServers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allServers
      .filter((s) => {
        if (categoryFilter !== 'all' && s.category !== categoryFilter) return false;
        if (onlyOfficial && !s.official) return false;
        if (onlyInstalled && !installedIds.has(s.id)) return false;
        if (!q) return true;
        return (
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q) ||
          s.author.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q))
        );
      })
      .slice()
      .sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name));
  }, [allServers, search, categoryFilter, onlyOfficial, onlyInstalled, installedIds]);

  const filtersActive =
    categoryFilter !== 'all' || onlyOfficial || onlyInstalled || !!search.trim();

  const selectedProject = projectsQuery.data?.find((p) => p.id === selectedProjectId);
  const selectedRepo = reposQuery.data?.find((r) => r.id === selectedRepoId);
  const isBuiltIn = selectedRepoId === BOWORA_MCP_REPOSITORY_ID;
  const isLoadingIndex = reposQuery.isPending || (!!selectedRepoId && repoIndexQuery.isPending);

  async function handlePickLocalFolder(): Promise<void> {
    const picked = await window.runova.mcp.pickLocalRepository();
    if (picked) setRepoSource(picked);
  }

  const handleInstallClick = useCallback(
    (server: McpServer) => {
      if (server.requiredEnv.length > 0) {
        setEnvValues(Object.fromEntries(server.requiredEnv.map((key) => [key, ''])));
        setEnvServer(server);
        return;
      }
      installMutation.mutate({ serverId: server.id });
    },
    [installMutation.mutate],
  );

  function handleConfirmEnvInstall(): void {
    if (!envServer) return;
    installMutation.mutate({ serverId: envServer.id, env: envValues });
    setEnvServer(null);
  }

  async function handleRemoveRepo(id: string): Promise<void> {
    const repo = reposQuery.data?.find((r) => r.id === id);
    const confirmed = await confirmDialog({
      title: `Remove "${repo?.name ?? 'this repository'}"?`,
      description:
        'This only removes the repository from Runova. Servers already installed in projects stay put.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (confirmed) removeRepoMutation.mutate(id);
  }

  const handleRemoveServer = useCallback(
    async (server: McpServer) => {
      const confirmed = await confirmDialog({
        title: `Remove "${server.name}"?`,
        description: selectedProject
          ? `This removes it from ${selectedProject.name}.`
          : 'This removes it from the selected project.',
        confirmLabel: 'Remove',
        variant: 'destructive',
      });
      if (confirmed) removeServerMutation.mutate(server.id);
    },
    [removeServerMutation.mutate, selectedProject],
  );

  function clearFilters(): void {
    setSearch('');
    setCategoryFilter('all');
    setOnlyOfficial(false);
    setOnlyInstalled(false);
  }

  usePageHeader(
    'MCP Marketplace',
    'Plug extra tools into a project from a repository of MCP servers.',
  );

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const server of allServers) {
      counts.set(server.category, (counts.get(server.category) ?? 0) + 1);
    }
    return counts;
  }, [allServers]);

  const repositories = reposQuery.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
      <CatalogSplit
        sidebar="mcpRepositories"
        sidebarLabel="MCP repositories"
        resizeLabel="Resize repositories"
        aside={
          <>
            <div className="flex h-10 shrink-0 items-center gap-0.5 pl-3.5 pr-2">
              <h2 className={cn(SECTION_HEADING, 'min-w-0 flex-1 truncate')}>Repositories</h2>
              <SimpleTooltip label="Add repository">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add repository"
                  onClick={() => setAddRepoOpen(true)}
                >
                  <Plus />
                </Button>
              </SimpleTooltip>
            </div>
            <div className="rail-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {reposQuery.isPending ? (
                <div role="status" aria-label="Loading repositories" className="space-y-1">
                  <Skeleton className="h-8 w-full rounded-lg" />
                  <Skeleton className="h-8 w-4/5 rounded-lg" />
                </div>
              ) : repositories.length === 0 ? (
                <p className="px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
                  No repositories yet. Add one to browse its servers.
                </p>
              ) : (
                <nav aria-label="Repositories" className="flex flex-col gap-px">
                  {repositories.map((repo) => (
                    <SideNavRow
                      key={repo.id}
                      group="mcp-repositories"
                      active={repo.id === selectedRepoId}
                      icon={
                        <RepositorySourceIcon
                          sourceType={repo.sourceType}
                          builtIn={repo.id === BOWORA_MCP_REPOSITORY_ID}
                        />
                      }
                      label={repo.name}
                      onSelect={() => {
                        setSelectedRepoId(repo.id);
                        setCategoryFilter('all');
                      }}
                    />
                  ))}
                </nav>
              )}

              {/* A repository with only one category has nothing to narrow down. */}
              {categories.length > 1 && (
                <>
                  <h3 className={cn(SECTION_HEADING, 'px-2.5 pb-1.5 pt-5')}>Categories</h3>
                  <div role="group" aria-label="Categories" className="flex flex-col gap-px">
                    <SideNavRow
                      group="mcp-categories"
                      active={categoryFilter === 'all'}
                      icon={<LayoutDashboard />}
                      label="All"
                      count={allServers.length}
                      onSelect={() => setCategoryFilter('all')}
                    />
                    {categories.map((category) => (
                      <SideNavRow
                        key={category}
                        group="mcp-categories"
                        active={categoryFilter === category}
                        icon={<Tag />}
                        label={category}
                        count={categoryCounts.get(category) ?? 0}
                        onSelect={() =>
                          setCategoryFilter(category === categoryFilter ? 'all' : category)
                        }
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        }
      >
        {/* The catalog's header card: which repository this is, where to install, and the
            filters, split by hairlines like the rows of a Settings card. */}
        <div className={cn(GLASS_CARD, 'settings-rows shrink-0')}>
          <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                {selectedRepo ? (
                  <RepositorySourceIcon
                    sourceType={selectedRepo.sourceType}
                    builtIn={isBuiltIn}
                    className="h-4 w-4"
                  />
                ) : (
                  <Plug className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="truncate text-sm font-semibold">
                    {selectedRepo?.name ?? 'MCP servers'}
                  </h2>
                  {isBuiltIn && (
                    <SimpleTooltip label="Bundled with Runova, always available with no network fetch needed">
                      <Chip tone="primary">Built-in</Chip>
                    </SimpleTooltip>
                  )}
                </div>
                {selectedRepo && !isBuiltIn && (
                  <p className="truncate text-xs text-muted-foreground">
                    {SOURCE_LABEL[selectedRepo.sourceType]} · {selectedRepo.source}
                  </p>
                )}
              </div>
            </div>
            <span className="text-xs text-muted-foreground">
              {isLoadingIndex
                ? 'Loading…'
                : filtersActive
                  ? `${filteredServers.length} of ${allServers.length}`
                  : `${allServers.length} server${allServers.length === 1 ? '' : 's'}`}
              {selectedProject && installedInCatalog > 0 && !onlyInstalled && (
                <>
                  {' · '}
                  {installedInCatalog} in {selectedProject.name}
                </>
              )}
            </span>
            {selectedRepoId && !isBuiltIn && (
              <div className="flex items-center gap-0.5">
                <SimpleTooltip label="Refresh">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Refresh repository"
                    disabled={refreshRepoMutation.isPending}
                    onClick={() => refreshRepoMutation.mutate(selectedRepoId)}
                  >
                    <RefreshCw
                      className={cn('h-3.5 w-3.5', refreshRepoMutation.isPending && 'animate-spin')}
                    />
                  </Button>
                </SimpleTooltip>
                <SimpleTooltip label="Remove repository">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="hover:text-destructive"
                    aria-label="Remove repository"
                    onClick={() => void handleRemoveRepo(selectedRepoId)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </SimpleTooltip>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <Combobox
              ariaLabel="Project"
              className={cn(
                'h-8 w-52 text-[13px]',
                !selectedProjectId && 'ring-1 ring-inset ring-warning/40',
              )}
              value={selectedProjectId}
              onChange={(id) => {
                setSelectedProjectId(id);
                if (!id) setOnlyInstalled(false);
              }}
              placeholder="Choose a project"
              searchPlaceholder="Search projects…"
              options={projectsQuery.data?.map((p) => ({ value: p.id, label: p.name })) ?? []}
              clearable
            />
            <SearchPill
              label="Search MCP servers"
              placeholder="Search by name, author, tag…"
              value={search}
              onValueChange={setSearch}
              className="min-w-48 flex-1"
            />
            <FilterChip active={onlyOfficial} onClick={() => setOnlyOfficial((v) => !v)}>
              Official
            </FilterChip>
            {selectedProjectId && (
              <FilterChip active={onlyInstalled} onClick={() => setOnlyInstalled((v) => !v)}>
                Installed{installedInCatalog > 0 ? ` (${installedInCatalog})` : ''}
              </FilterChip>
            )}
          </div>

          {!selectedProjectId && (
            <p className="flex items-center gap-2 px-3.5 py-2 text-xs text-muted-foreground">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
              Choose a project to install servers into it.
            </p>
          )}
        </div>

        {repoIndexQuery.isError && (
          <div
            className={cn(
              GLASS_CARD,
              'flex shrink-0 flex-wrap items-center gap-3 px-3.5 py-2.5 text-sm ring-1 ring-inset ring-destructive/30',
            )}
          >
            <TriangleAlert className="h-4 w-4 shrink-0 text-destructive" />
            <span className="text-destructive">Couldn't load this repository.</span>
            {!isBuiltIn && selectedRepoId && (
              <Button
                variant="soft"
                size="sm"
                className="ml-auto"
                onClick={() => refreshRepoMutation.mutate(selectedRepoId)}
              >
                <RefreshCw /> Try again
              </Button>
            )}
          </div>
        )}

        {/* The cards scroll on their own, under the header card, like a Settings page. */}
        <div className="rail-scroll @container/grid min-h-0 flex-1 overflow-y-auto">
          {isLoadingIndex ? (
            <div className={CARD_GRID} role="status" aria-label="Loading servers">
              {Array.from({ length: 6 }, (_, i) => (
                <CatalogCardShimmer key={i} />
              ))}
            </div>
          ) : filteredServers.length === 0 ? (
            <div className={GLASS_CARD}>
              <EmptyState
                size="lg"
                icon={filtersActive ? Search : Plug}
                title={
                  allServers.length === 0
                    ? selectedRepo
                      ? `${selectedRepo.name} is empty`
                      : 'No servers yet'
                    : 'No servers match'
                }
                description={
                  allServers.length === 0
                    ? 'Refresh this repository, or add a different one to browse its servers.'
                    : 'Try a different search or clear the filters.'
                }
                action={
                  filtersActive ? (
                    <Button variant="soft" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  ) : (
                    <Button onClick={() => setAddRepoOpen(true)}>
                      <Plus /> Add repository
                    </Button>
                  )
                }
              />
            </div>
          ) : (
            <div className={CARD_GRID}>
              {filteredServers.map((server) => (
                <McpServerCard
                  key={server.id}
                  server={server}
                  isInstalled={installedIds.has(server.id)}
                  canInstall={!!selectedProjectId}
                  isInstalling={
                    installMutation.isPending && installMutation.variables?.serverId === server.id
                  }
                  showCategory={categories.length > 1}
                  isRemoving={
                    removeServerMutation.isPending && removeServerMutation.variables === server.id
                  }
                  onInstall={handleInstallClick}
                  onRemove={handleRemoveServer}
                />
              ))}
            </div>
          )}
        </div>
      </CatalogSplit>

      <Dialog
        open={addRepoOpen}
        onOpenChange={(open) => {
          setAddRepoOpen(open);
          if (!open) {
            setRepoName('');
            setRepoSource('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add repository</DialogTitle>
            <DialogDescription>
              Point Runova at a folder of MCP servers, a git repository, or a JSON index.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                placeholder="Community repository"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Combobox
                value={repoSourceType}
                onChange={(v) => setRepoSourceType(v as McpRepositorySourceType)}
                options={SOURCE_TYPES.map((t) => ({ value: t.value, label: t.label }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{repoSourceType === 'local-folder' ? 'Folder' : 'Source'}</Label>
              {repoSourceType === 'local-folder' ? (
                <div className="flex gap-2">
                  <Input value={repoSource} readOnly placeholder="Choose a folder…" />
                  <SimpleTooltip label="Browse for a folder">
                    <Button
                      type="button"
                      variant="soft"
                      size="icon"
                      className="h-9 w-9"
                      aria-label="Browse for a folder"
                      onClick={() => void handlePickLocalFolder()}
                    >
                      <FolderOpen className="h-4 w-4" />
                    </Button>
                  </SimpleTooltip>
                </div>
              ) : (
                <Input
                  value={repoSource}
                  onChange={(e) => setRepoSource(e.target.value)}
                  placeholder={
                    repoSourceType === 'git'
                      ? 'https://github.com/org/mcp-servers.git'
                      : 'https://example.com/repository.json'
                  }
                />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              disabled={!repoName.trim() || !repoSource.trim() || addRepoMutation.isPending}
              onClick={() => addRepoMutation.mutate()}
            >
              {addRepoMutation.isPending && <Spinner className="animate-spin" />}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!envServer} onOpenChange={(open) => !open && setEnvServer(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configure {envServer?.name}</DialogTitle>
            <DialogDescription>
              This server needs a few values before it can connect. They're written to{' '}
              {selectedProject ? `${selectedProject.name}'s` : "this project's"}{' '}
              <code>.mcp.json</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {envServer?.requiredEnv.map((key) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`mcp-env-${key}`}>{key}</Label>
                <Input
                  id={`mcp-env-${key}`}
                  type="password"
                  autoComplete="off"
                  value={envValues[key] ?? ''}
                  onChange={(e) => setEnvValues((prev) => ({ ...prev, [key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="soft" onClick={() => setEnvServer(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                installMutation.isPending ||
                (envServer?.requiredEnv.some((key) => !envValues[key]?.trim()) ?? false)
              }
              onClick={handleConfirmEnvInstall}
            >
              {installMutation.isPending ? <Spinner className="animate-spin" /> : <Plug />}
              Install
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
