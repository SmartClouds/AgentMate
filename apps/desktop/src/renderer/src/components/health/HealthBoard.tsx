import type { Project } from '@agentmat/core';
import type { ProjectEnvironment } from '@shared/apiTypes';
import type { HealthTargetSummary } from '@shared/healthTypes';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { HeartPulse, Plus, Sparkles } from '@/components/icons';
import {
  CARD_GRID,
  Chip,
  EmptyState,
  FilterChip,
  GLASS_CARD,
  LoadFailure,
  Notice,
  PillTabs,
  SECTION_HEADING,
  SearchPill,
  TOOLBAR,
} from '@/components/pageKit';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { HealthAvailabilityChart } from './HealthAvailabilityChart';
import { HealthBuildDialog } from './HealthBuildDialog';
import { HealthPulseHeader } from './HealthPulseHeader';
import { HealthSetupDialog } from './HealthSetupDialog';
import { HealthTargetCard, HealthTargetCardSkeleton } from './HealthTargetCard';
import { HealthTargetDetail } from './HealthTargetDetail';
import { HealthTargetDialog } from './HealthTargetDialog';
import {
  groupHealthTargets,
  type HealthEnvironmentGroup,
  type HealthStatusFilter,
  healthBucket,
  matchesHealthSearch,
  NO_ENVIRONMENT,
  summarizeHealth,
} from './healthView';
import { useHealthTargets, useNow } from './useHealth';

/**
 * The Monitoring view: the overview, the filters, and the targets grouped by project and then
 * environment. The Monitoring page shows every project; a project's own tab passes `projectId` and
 * gets the same view for just that project. `?target=<id>` opens a target's panel, so links from
 * notifications land on it.
 */

const QUIET = { silentLoading: true } as const;
const NO_ENV_VALUE = '__none__';

const STEPS = [
  {
    title: 'Have your AI build the endpoint',
    body: 'Build with AI gives Claude Code, or any agent, a prompt with the whole protocol. It adds a secured endpoint that checks every service the project uses.',
  },
  {
    title: 'Add a target',
    body: "The endpoint's address, one per environment or server. You get a key, and its hash goes on the server.",
  },
  {
    title: 'Test the connection',
    body: 'AgentMate checks it on its schedule and tells you when something breaks.',
  },
];

function FirstRun({
  onAdd,
  onBuild,
}: {
  onAdd: () => void;
  onBuild: () => void;
}): React.JSX.Element {
  return (
    <div className={GLASS_CARD}>
      <EmptyState
        size="lg"
        icon={HeartPulse}
        title="Know the moment your app stops answering"
        description={
          <div className="space-y-4 pt-1">
            <p>
              AgentMate checks a secured endpoint in each environment on its own schedule, and when
              something fails it shows what broke and asks an agent why.
            </p>
            <ol aria-label="How to start" className="space-y-2.5 text-left">
              {STEPS.map((step, i) => (
                <li key={step.title} className="flex gap-3">
                  <span
                    aria-hidden
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/12 text-[11px] font-semibold text-primary"
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{step.title}</span>
                    <span className="block text-xs leading-relaxed">{step.body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={onBuild}>
              <Sparkles />
              Build with AI
            </Button>
            <Button variant="soft" onClick={onAdd}>
              <Plus />
              Add a target
            </Button>
          </div>
        }
      />
    </div>
  );
}

function EnvironmentGroup({
  group,
  now,
  selectedId,
  onOpen,
}: {
  group: HealthEnvironmentGroup;
  now: number;
  selectedId: string | null;
  onOpen: (targetId: string) => void;
}): React.JSX.Element {
  const headingId = useId();
  const down = group.targets.filter((one) => healthBucket(one.state) === 'down').length;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <h3 id={headingId} className={SECTION_HEADING}>
          {group.name}
        </h3>
        <span className="text-[10px] tabular-nums text-muted-foreground/70">
          {group.targets.length}
        </span>
        {down > 0 && (
          <Chip tone="destructive" dot>
            {down} down
          </Chip>
        )}
      </div>
      <div className="@container/grid">
        <div className={CARD_GRID}>
          {group.targets.map((one) => (
            <HealthTargetCard
              key={one.id}
              target={one}
              now={now}
              onOpen={onOpen}
              selected={one.id === selectedId}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function ProjectGroup({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="px-1 text-sm font-semibold tracking-tight">
        {name}
      </h2>
      {children}
    </section>
  );
}

export function HealthBoard({ projectId }: { projectId?: string }): React.JSX.Element {
  const scoped = projectId !== undefined;
  const now = useNow();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('target');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<HealthStatusFilter>('all');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [envFilter, setEnvFilter] = useState('');
  const [adding, setAdding] = useState(false);
  /** The project a target is added for when Build with AI hands over to the add dialog. */
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [editing, setEditing] = useState<HealthTargetSummary | null>(null);
  /** The target the setup dialog is for. An id, so a just-created one shows once the list has it. */
  const [setupId, setSetupId] = useState<string | null>(null);

  const list = useHealthTargets(projectId);
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: async (): Promise<Project[]> => (await window.agentmat.projects.list()) ?? [],
    meta: QUIET,
  });
  const projects = projectsQuery.data ?? [];

  // Only this project's targets, even if the list ever answers with more.
  const all = useMemo(
    () => (list.targets ?? []).filter((one) => !scoped || one.projectId === projectId),
    [list.targets, scoped, projectId],
  );

  const projectIds = useMemo(
    () => [...new Set([...(projectId ? [projectId] : []), ...all.map((one) => one.projectId)])],
    [all, projectId],
  );
  const environmentQueries = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: queryKeys.projectEnvironments(id),
      queryFn: async (): Promise<ProjectEnvironment[]> =>
        (await window.agentmat.environments.list(id)) ?? [],
      meta: QUIET,
    })),
  });
  const environments = new Map<string, ProjectEnvironment>();
  for (const result of environmentQueries) {
    for (const env of result.data ?? []) environments.set(env.id, env);
  }

  const envName = (one: HealthTargetSummary): string =>
    (one.environmentId && environments.get(one.environmentId)?.name) || NO_ENVIRONMENT;
  const envOptions = [...new Set(all.map(envName))].sort((a, b) => a.localeCompare(b));

  // The chart follows where the user is looking (project and environment), the cards also
  // follow the search and the status filter.
  const inView = all.filter((one) => {
    if (projectFilter && one.projectId !== projectFilter) return false;
    return !envFilter || envName(one) === (envFilter === NO_ENV_VALUE ? NO_ENVIRONMENT : envFilter);
  });
  const visible = inView.filter((one) => {
    if (status !== 'all' && healthBucket(one.state) !== status) return false;
    return matchesHealthSearch(one, query);
  });
  const groups = groupHealthTargets(visible, projects, environments);
  const summary = summarizeHealth(all);
  const projectsWithTargets = projects.filter((one) => all.some((t) => t.projectId === one.id));
  function openTarget(id: string | null): void {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set('target', id);
        else next.delete('target');
        return next;
      },
      { replace: id === null },
    );
  }

  function clearFilters(): void {
    setQuery('');
    setStatus('all');
    setProjectFilter(null);
    setEnvFilter('');
  }

  // Hold the shimmer until the environment names are in, so cards do not regroup under the user.
  const loading = list.isLoading || environmentQueries.some((result) => result.isPending);
  const selected = all.find((one) => one.id === selectedId);
  const setupTarget = setupId ? all.find((one) => one.id === setupId) : undefined;
  const firstRun = !loading && !list.error && all.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <HealthPulseHeader summary={summary} loading={loading} active={status} onSelect={setStatus} />

      {!firstRun && !list.error && (
        <HealthAvailabilityChart
          targets={inView}
          loading={loading}
          now={now}
          onOpenTarget={openTarget}
        />
      )}

      {!firstRun && (
        <div className={TOOLBAR}>
          <SearchPill
            type="search"
            label="Search targets"
            clearLabel="Clear filter"
            placeholder="Search by name, server or host"
            value={query}
            onValueChange={setQuery}
            className="w-full min-w-48 max-w-xs flex-1"
          />
          <PillTabs
            id={`health-status-${projectId ?? 'all'}`}
            kind="toggle"
            label="Status"
            size="xs"
            value={status}
            onChange={setStatus}
            items={[
              { value: 'all', label: 'All', count: summary.total },
              { value: 'down', label: 'Down', count: summary.down, countTone: 'destructive' },
              {
                value: 'degraded',
                label: 'Degraded',
                count: summary.degraded,
                countTone: 'warning',
              },
              { value: 'healthy', label: 'Healthy', count: summary.healthy },
              { value: 'paused', label: 'Paused', count: summary.paused },
            ]}
          />
          {envOptions.length > 1 && (
            <Combobox
              ariaLabel="Environment filter"
              value={envFilter}
              onChange={setEnvFilter}
              className="h-8 w-44 text-xs"
              searchPlaceholder="Search environments…"
              emptyText="No environment matches."
              options={[
                { value: '', label: 'All environments' },
                ...envOptions.map((name) => ({
                  value: name === NO_ENVIRONMENT ? NO_ENV_VALUE : name,
                  label: name,
                })),
              ]}
            />
          )}
          <Button size="sm" variant="soft" className="ml-auto" onClick={() => setBuilding(true)}>
            <Sparkles />
            Build with AI
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus />
            Add target
          </Button>
          {!scoped && projectsWithTargets.length > 1 && (
            <div
              className="flex w-full flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Projects"
            >
              <FilterChip active={projectFilter === null} onClick={() => setProjectFilter(null)}>
                All projects
              </FilterChip>
              {projectsWithTargets.map((one) => (
                <FilterChip
                  key={one.id}
                  active={projectFilter === one.id}
                  onClick={() => setProjectFilter(projectFilter === one.id ? null : one.id)}
                >
                  {one.name}
                </FilterChip>
              ))}
            </div>
          )}
        </div>
      )}

      {list.failure && (
        <Notice
          tone="warning"
          size="sm"
          action={
            <Button size="xs" variant="soft" onClick={list.refresh}>
              Try again
            </Button>
          }
        >
          Could not refresh: {list.failure.message} Showing the last data that loaded.
        </Notice>
      )}

      {loading ? (
        <div className="@container/grid" role="status" aria-label="Loading health checks">
          <div className={CARD_GRID}>
            <HealthTargetCardSkeleton />
            <HealthTargetCardSkeleton />
            <HealthTargetCardSkeleton />
          </div>
        </div>
      ) : list.error ? (
        <LoadFailure
          message={`Could not load the health checks: ${ipcErrorMessage(list.error, 'Something went wrong.')}`}
          retry={list.refresh}
        />
      ) : firstRun ? (
        <FirstRun onAdd={() => setAdding(true)} onBuild={() => setBuilding(true)} />
      ) : groups.length === 0 ? (
        <div className={GLASS_CARD}>
          <EmptyState
            size="sm"
            icon={HeartPulse}
            title="Nothing matches these filters"
            action={
              <Button size="sm" variant="soft" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        </div>
      ) : (
        <div className={cn('flex flex-col', scoped ? 'gap-4' : 'gap-6')}>
          {groups.map((group) => {
            const body = group.environments.map((env) => (
              <EnvironmentGroup
                key={env.environmentId ?? 'none'}
                group={env}
                now={now}
                selectedId={selectedId}
                onOpen={openTarget}
              />
            ));
            return scoped ? (
              <div key={group.projectId} className="flex flex-col gap-4">
                {body}
              </div>
            ) : (
              <ProjectGroup key={group.projectId} name={group.projectName}>
                {body}
              </ProjectGroup>
            );
          })}
        </div>
      )}

      <HealthTargetDetail
        targetId={selectedId}
        onClose={() => openTarget(null)}
        onEdit={setEditing}
        onSetup={(one) => setSetupId(one.id)}
        projects={projects}
        environmentName={selected ? envName(selected) : null}
        now={now}
      />

      <HealthTargetDialog
        open={adding || editing !== null}
        onOpenChange={(open) => {
          if (open) return;
          setAdding(false);
          setAddingFor(null);
          setEditing(null);
        }}
        projects={projects}
        defaultProjectId={projectId ?? addingFor ?? projectFilter ?? undefined}
        lockProject={scoped}
        target={editing ?? undefined}
        onConnect={setSetupId}
      />

      <HealthBuildDialog
        open={building}
        onOpenChange={setBuilding}
        projects={projects}
        // Only a project the user is already looking at, or the only one there is. Guessing
        // (the newest, say) sent the agent to a project nobody picked.
        defaultProjectId={
          projectId ?? projectFilter ?? (projects.length === 1 ? projects[0]?.id : undefined)
        }
        lockProject={scoped}
        onAddTarget={(id) => {
          setAddingFor(id);
          setAdding(true);
        }}
      />

      {setupTarget && (
        <HealthSetupDialog
          open
          onOpenChange={(open) => !open && setSetupId(null)}
          target={setupTarget}
          project={projects.find((one) => one.id === setupTarget.projectId)}
        />
      )}
    </div>
  );
}
