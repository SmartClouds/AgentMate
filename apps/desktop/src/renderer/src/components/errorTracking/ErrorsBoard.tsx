import type { ErrorPeriod, Project } from '@agentmat/core';
import type {
  ErrorIssueSort,
  ErrorIssueSummary,
  ErrorStatusFilter,
} from '@shared/errorTrackingTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Bug,
  CircleCheck,
  Copy,
  ExternalLink,
  Link,
  Lock,
  Plug,
  RefreshCw,
  Spinner,
} from '@/components/icons';
import {
  Chip,
  EmptyState,
  FilterChip,
  GLASS_CARD,
  LoadFailure,
  Notice,
  PillTabs,
  SearchPill,
  TOOLBAR,
} from '@/components/pageKit';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { SshVaultUnlockDialog } from '@/components/remote/SshVaultUnlockDialog';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { formatAgo } from '../health/healthView';
import { copyText } from '../health/promptParts';
import { useNow } from '../health/useHealth';
import { ErrorConnectionsDialog } from './ErrorConnectionsDialog';
import { ErrorFixDialog } from './ErrorFixDialog';
import { ErrorIssueDetail } from './ErrorIssueDetail';
import { ErrorIssueRow, ErrorIssueRowSkeleton } from './ErrorIssueRow';
import { ErrorLinkProjects } from './ErrorLinkProjects';
import {
  DEFAULT_PERIOD,
  DEFAULT_SORT,
  DEFAULT_STATUS,
  groupIssuesByProject,
  issueParam,
  PERIOD_ITEMS,
  parseIssueParam,
  SCOPE_LIST_TEXT,
  SORT_OPTIONS,
  STATUS_ITEMS,
  tokenPageUrl,
} from './errorView';
import {
  fetchErrorFixPrompt,
  issueFilter,
  useErrorConnections,
  useErrorEnvironments,
  useErrorIssues,
  useErrorLinks,
} from './useErrorTracking';

/**
 * The Errors tab of Monitoring (E24): what Sentry recorded for the linked projects, newest first,
 * in a dense list with the filters Sentry itself offers. The Monitoring page shows every linked
 * project grouped by project; a project's own tab passes `projectId` and gets just that project.
 * `?issue=<connectionId>:<issueId>` opens an issue's panel.
 */

const QUIET = { silentLoading: true } as const;
const SEARCH_DEBOUNCE_MS = 400;
const ALL_ENVIRONMENTS = '';

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: 'Create a Sentry auth token',
    body: (
      <>
        A personal token with the scopes below. Add event:write too if you want to resolve and
        ignore issues from here. Sentry cannot add scopes to a token later.
      </>
    ),
  },
  {
    title: 'Connect it',
    body: 'Paste the token and pick your organization. AgentMate checks what the token can read before it saves anything.',
  },
  {
    title: 'Link your projects',
    body: 'Match each project to its Sentry projects. The likely ones are picked for you.',
  },
];

function FirstRun({ onConnect }: { onConnect: () => void }): React.JSX.Element {
  return (
    <div className={GLASS_CARD}>
      <EmptyState
        size="lg"
        icon={Bug}
        title="See what breaks for your users"
        description={
          <div className="space-y-4 pt-1">
            <p>
              Connect Sentry and each project’s errors show up here, with the stack trace and what
              led to it, ready to copy or hand to an agent to fix.
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
                  <span className="min-w-0 space-y-2">
                    <span className="block text-sm font-medium text-foreground">{step.title}</span>
                    <span className="block text-xs leading-relaxed">{step.body}</span>
                    {i === 0 && (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {['org:read', 'project:read', 'event:read'].map((scope) => (
                          <Chip key={scope} className="font-mono">
                            {scope}
                          </Chip>
                        ))}
                        <Chip tone="primary" className="font-mono">
                          event:write, optional
                        </Chip>
                        <Button
                          size="xs"
                          variant="soft"
                          onClick={() => copyText(SCOPE_LIST_TEXT, 'Scopes')}
                        >
                          <Copy />
                          Copy scopes
                        </Button>
                        <Button size="xs" variant="ghost" asChild>
                          <a
                            href={tokenPageUrl('https://sentry.io')}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink />
                            Open the token page
                          </a>
                        </Button>
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        }
        action={
          <Button onClick={onConnect}>
            <Plug />
            Connect Sentry
          </Button>
        }
      />
    </div>
  );
}

function ListShimmer({ rows = 4 }: { rows?: number }): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label="Loading issues"
      className={cn(GLASS_CARD, '@container/issues divide-y divide-foreground/[0.06] px-1')}
    >
      {Array.from({ length: rows }, (_, i) => `row-${i}`).map((key) => (
        <ErrorIssueRowSkeleton key={key} />
      ))}
    </div>
  );
}

export function ErrorsBoard({ projectId }: { projectId?: string }): React.JSX.Element {
  const scoped = projectId !== undefined;
  const now = useNow();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const openRef = parseIssueParam(searchParams.get('issue'));

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, SEARCH_DEBOUNCE_MS);
  const [status, setStatus] = useState<ErrorStatusFilter>(DEFAULT_STATUS);
  const [period, setPeriod] = useState<ErrorPeriod>(DEFAULT_PERIOD);
  const [sort, setSort] = useState<ErrorIssueSort>(DEFAULT_SORT);
  const [environment, setEnvironment] = useState(ALL_ENVIRONMENTS);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [fixing, setFixing] = useState<ErrorIssueSummary | null>(null);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: async (): Promise<Project[]> => (await window.agentmat.projects.list()) ?? [],
    meta: QUIET,
  });
  const projects = projectsQuery.data ?? [];

  const connections = useErrorConnections();
  const connList = connections.data ?? [];
  const hasConnection = connList.length > 0;
  const links = useErrorLinks(projectId, hasConnection);
  const linkList = (links.data ?? []).filter((one) => !scoped || one.projectId === projectId);
  const linked = linkList.length > 0;

  const queryProject = projectId ?? projectFilter ?? undefined;
  const environments = useErrorEnvironments(queryProject, linked);
  const envOptions = environments.data ?? [];

  const filter = useMemo(
    () =>
      issueFilter({
        projectId: queryProject,
        status,
        period,
        sort,
        environment: environment || null,
        search: debouncedSearch,
      }),
    [queryProject, status, period, sort, environment, debouncedSearch],
  );
  const issues = useErrorIssues(filter, { enabled: linked });

  const locked =
    connList.some((one) => one.locked) || issues.failures.some((failure) => failure.locked);
  const partial = issues.failures.filter((failure) => !failure.locked);
  // Every connection failed: the failures say so, and an empty list must not read as "all clear".
  const nothingRead = issues.loaded && issues.issues.length === 0 && issues.failures.length > 0;
  const linkedProjects = projects.filter((one) => linkList.some((l) => l.projectId === one.id));
  const scopedProject = scoped ? projects.find((one) => one.id === projectId) : undefined;
  const fixProject = fixing ? projects.find((one) => one.id === fixing.projectId) : undefined;
  const filtered =
    status !== DEFAULT_STATUS || environment !== ALL_ENVIRONMENTS || debouncedSearch.trim() !== '';

  function openIssue(issue: ErrorIssueSummary | null): void {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (issue)
          next.set('issue', issueParam({ connectionId: issue.connectionId, issueId: issue.id }));
        else next.delete('issue');
        return next;
      },
      { replace: issue === null },
    );
  }

  async function copyForAi(issue: ErrorIssueSummary): Promise<void> {
    try {
      const prompt = await fetchErrorFixPrompt(queryClient, {
        connectionId: issue.connectionId,
        issueId: issue.id,
      });
      if (prompt?.prompt) copyText(prompt.prompt, 'Prompt');
      else toast.info('Sentry has no event for this issue, so there is nothing to copy.');
    } catch (error) {
      toast.error('Could not build the prompt', {
        description: ipcErrorMessage(error, 'Something went wrong.'),
      });
    }
  }

  function clearFilters(): void {
    setSearch('');
    setStatus(DEFAULT_STATUS);
    setEnvironment(ALL_ENVIRONMENTS);
  }

  const lockedNotice = locked && (
    <Notice
      tone="warning"
      icon={Lock}
      size="sm"
      className="items-center"
      action={
        <Button size="xs" onClick={() => setUnlockOpen(true)}>
          Unlock
        </Button>
      }
    >
      Your saved servers are locked with a passkey, and the Sentry tokens with them. Unlock them to
      read the errors.
    </Notice>
  );

  const dialogs = (
    <>
      <ErrorConnectionsDialog
        open={connectionsOpen}
        onOpenChange={setConnectionsOpen}
        projects={scopedProject ? [scopedProject] : projects}
      />
      <SshVaultUnlockDialog
        open={unlockOpen}
        onOpenChange={setUnlockOpen}
        mode="unlock"
        onUnlocked={() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.sshVaultStatus });
          void queryClient.invalidateQueries({ queryKey: queryKeys.errorTracking });
        }}
      />
    </>
  );

  // Before there is anything to filter: loading, no connection, or nothing linked yet.
  if (connections.isLoading || (hasConnection && links.isLoading)) {
    return (
      <div className="flex flex-col gap-2">
        <ListShimmer />
        {dialogs}
      </div>
    );
  }
  if (connections.isError) {
    return (
      <LoadFailure
        message={`Could not load the error tracking connections: ${ipcErrorMessage(connections.error, 'Something went wrong.')}`}
        retry={() => void connections.refetch()}
      />
    );
  }
  if (!hasConnection) {
    return (
      <div className="flex flex-col gap-2">
        <FirstRun onConnect={() => setConnectionsOpen(true)} />
        {dialogs}
      </div>
    );
  }
  if (!linked) {
    return (
      <div className="flex flex-col gap-2">
        {lockedNotice}
        {scoped && scopedProject ? (
          <div className={cn(GLASS_CARD, 'p-4')}>
            <ErrorLinkProjects
              projects={[scopedProject]}
              connections={connList}
              links={[]}
              title="Link projects"
              description={`Pick the Sentry projects that hold ${scopedProject.name}’s errors, and they show up here.`}
            />
          </div>
        ) : (
          <div className={GLASS_CARD}>
            <EmptyState
              icon={Link}
              title="Link your projects to Sentry"
              description="Sentry is connected. Pick which Sentry projects belong to each of your projects, and their errors show up here."
              action={
                <Button size="sm" onClick={() => setConnectionsOpen(true)}>
                  <Link />
                  Link projects
                </Button>
              }
            />
          </div>
        )}
        {dialogs}
      </div>
    );
  }

  const groups = scoped ? null : groupIssuesByProject(issues.issues, projects);

  return (
    <div className="flex flex-col gap-2">
      <div className={TOOLBAR}>
        <SearchPill
          type="search"
          label="Search issues"
          clearLabel="Clear search"
          placeholder="Search issues or Sentry queries"
          value={search}
          onValueChange={setSearch}
          className="w-full min-w-48 max-w-xs flex-1"
        />
        <PillTabs
          id={`error-status-${projectId ?? 'all'}`}
          kind="toggle"
          label="Issue status"
          size="xs"
          value={status}
          onChange={setStatus}
          items={STATUS_ITEMS}
        />
        <PillTabs
          id={`error-period-${projectId ?? 'all'}`}
          kind="toggle"
          label="Period"
          size="xs"
          value={period}
          onChange={setPeriod}
          items={PERIOD_ITEMS}
        />
        {envOptions.length > 0 && (
          <Combobox
            ariaLabel="Environment filter"
            value={environment}
            onChange={setEnvironment}
            className="h-8 w-40 text-xs"
            searchPlaceholder="Search environments…"
            emptyText="No environment matches."
            options={[
              { value: ALL_ENVIRONMENTS, label: 'All environments' },
              ...envOptions.map((name) => ({ value: name, label: name })),
            ]}
          />
        )}
        <Combobox
          ariaLabel="Sort issues"
          value={sort}
          onChange={(value) => setSort((value || DEFAULT_SORT) as ErrorIssueSort)}
          className="h-8 w-36 text-xs"
          searchPlaceholder="Sort by…"
          options={SORT_OPTIONS}
        />
        <div className="ml-auto flex items-center gap-1.5">
          {issues.fetchedAt !== null && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {issues.fetchedAt > now - 10_000
                ? 'Updated just now'
                : `Updated ${formatAgo(issues.fetchedAt, now)}`}
            </span>
          )}
          <SimpleTooltip label="Read Sentry again now">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh issues"
              aria-busy={issues.isFetching}
              onClick={issues.refresh}
            >
              <RefreshCw className={cn(issues.isFetching && 'animate-spin')} />
            </Button>
          </SimpleTooltip>
          <Button size="sm" variant="soft" onClick={() => setConnectionsOpen(true)}>
            <Plug />
            Connections
          </Button>
        </div>
        {!scoped && linkedProjects.length > 1 && (
          <div
            className="flex w-full flex-wrap items-center gap-1.5"
            role="group"
            aria-label="Projects"
          >
            <FilterChip active={projectFilter === null} onClick={() => setProjectFilter(null)}>
              All projects
            </FilterChip>
            {linkedProjects.map((one) => (
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

      {lockedNotice}

      {partial.map((failure) =>
        nothingRead ? (
          <LoadFailure
            key={failure.connectionId}
            message={`Could not read ${failure.label}: ${failure.message}`}
            retry={issues.refresh}
          />
        ) : (
          <Notice
            key={failure.connectionId}
            tone="warning"
            size="sm"
            action={
              <Button size="xs" variant="soft" onClick={() => setConnectionsOpen(true)}>
                Connections
              </Button>
            }
          >
            Could not read {failure.label}: {failure.message} The issues below come from your other
            connections.
          </Notice>
        ),
      )}

      {issues.stale && (
        <Notice
          tone="warning"
          size="sm"
          action={
            <Button size="xs" variant="soft" onClick={issues.refresh}>
              {issues.moreFailed ? 'Refresh the list' : 'Try again'}
            </Button>
          }
        >
          {issues.moreFailed
            ? `Could not load more: ${issues.stale}`
            : `Could not refresh: ${issues.stale} Showing the last issues that loaded.`}
        </Notice>
      )}

      {issues.isLoading ? (
        <ListShimmer />
      ) : issues.error ? (
        <LoadFailure
          message={`Could not load the issues: ${ipcErrorMessage(issues.error, 'Something went wrong.')}`}
          retry={issues.refresh}
        />
      ) : nothingRead ? null : issues.issues.length === 0 ? (
        <div className={GLASS_CARD}>
          {filtered ? (
            <EmptyState
              size="sm"
              icon={Bug}
              title="Nothing matches these filters"
              action={
                <Button size="sm" variant="soft" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              size="sm"
              icon={CircleCheck}
              title={`No unresolved errors in the last ${PERIOD_ITEMS.find((one) => one.value === period)?.label ?? period}`}
              description="Sentry has recorded nothing new that needs you. Enjoy it."
            />
          )}
        </div>
      ) : (
        <div className={cn(GLASS_CARD, '@container/issues px-1 py-1')}>
          <ul
            aria-label="Issues"
            aria-busy={issues.isPlaceholder || undefined}
            className={cn(
              'transition-opacity [&>li+li]:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.06)]',
              issues.isPlaceholder && 'opacity-60',
            )}
          >
            {(
              groups ?? [{ projectId: projectId ?? '', projectName: '', issues: issues.issues }]
            ).map((group) => [
              groups ? (
                <li
                  key={`head-${group.projectId}`}
                  role="none"
                  className="flex items-center gap-2 px-2 pb-1.5 pt-3 first:pt-2"
                >
                  <h2 className="text-sm font-semibold tracking-tight">{group.projectName}</h2>
                  <span className="text-[10px] tabular-nums text-muted-foreground/70">
                    {group.issues.length}
                  </span>
                </li>
              ) : null,
              ...group.issues.map((issue) => (
                <ErrorIssueRow
                  key={`${issue.connectionId}:${issue.id}`}
                  issue={issue}
                  now={now}
                  onOpen={openIssue}
                  onFix={setFixing}
                  onCopy={(one) => void copyForAi(one)}
                  selected={
                    openRef?.connectionId === issue.connectionId && openRef.issueId === issue.id
                  }
                />
              )),
            ])}
          </ul>
          {issues.hasMore && (
            <div className="flex justify-center py-2">
              <Button
                size="sm"
                variant="soft"
                disabled={issues.loadingMore}
                onClick={issues.loadMore}
              >
                {issues.loadingMore && <Spinner className="animate-spin" />}
                Load more
              </Button>
            </div>
          )}
        </div>
      )}

      <ErrorIssueDetail
        issueRef={openRef}
        onClose={() => openIssue(null)}
        projects={projects}
        now={now}
      />

      {fixing && fixProject && (
        <ErrorFixDialog
          project={fixProject}
          issue={fixing}
          open
          onOpenChange={(open) => !open && setFixing(null)}
        />
      )}

      {dialogs}
    </div>
  );
}
