import { type Project, type RemoteProject, suggestRemoteProjects } from '@runova/core';
import type { ErrorConnectionSummary, ErrorProjectLink } from '@shared/errorTrackingTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Link, Spinner } from '@/components/icons';
import { Notice, SECTION_HEADING } from '@/components/pageKit';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { MultiCombobox, type MultiComboboxOption } from './MultiCombobox';
import { useRemoteProjects } from './useErrorTracking';

/**
 * Which Sentry projects hold each Runova project's errors (E24). A project that has no links
 * yet starts with the ones that look like it already picked, so for most users linking is one
 * look and one click. Saving replaces each changed project's links as a whole.
 */

function optionValue(connectionId: string, remoteProjectId: string): string {
  return `${connectionId}:${remoteProjectId}`;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((one) => b.includes(one));
}

export function ErrorLinkProjects({
  projects,
  connections,
  links,
  title = 'Link projects',
  description,
  onSaved,
  className,
}: {
  projects: readonly Project[];
  connections: readonly ErrorConnectionSummary[];
  /** The links the projects have now. */
  links: readonly ErrorProjectLink[];
  title?: string;
  description?: React.ReactNode;
  onSaved?: () => void;
  className?: string;
}): React.JSX.Element {
  const headingId = useId();
  const queryClient = useQueryClient();
  const usable = connections.filter((one) => !one.locked);
  const remote = useRemoteProjects(usable.map((one) => one.id));
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const several = usable.length > 1;

  const options = useMemo(() => {
    const list: MultiComboboxOption[] = [];
    for (const conn of usable) {
      for (const one of remote.byConnection.get(conn.id) ?? []) {
        list.push({
          value: optionValue(conn.id, one.id),
          label: one.name,
          detail: several ? conn.label : one.slug !== one.name ? one.slug : undefined,
          keywords: [one.slug],
        });
      }
    }
    return list;
  }, [usable, remote.byConnection, several]);

  const remoteByValue = new Map<string, { connectionId: string; project: RemoteProject }>();
  for (const conn of usable) {
    for (const one of remote.byConnection.get(conn.id) ?? []) {
      remoteByValue.set(optionValue(conn.id, one.id), { connectionId: conn.id, project: one });
    }
  }

  function current(projectId: string): string[] {
    return links
      .filter((one) => one.projectId === projectId)
      .map((one) => optionValue(one.connectionId, one.remoteProjectId));
  }

  /** What a project starts with: its links, or the suggestions when it has none. */
  function initial(project: Project): { values: string[]; suggested: boolean } {
    const now = current(project.id);
    if (now.length > 0 || remote.isLoading) return { values: now, suggested: false };
    const candidate = {
      name: project.name,
      folderPath: project.folderPath || null,
      repoUrl: project.repoUrl || null,
    };
    const values = usable.flatMap((conn) =>
      suggestRemoteProjects(candidate, remote.byConnection.get(conn.id) ?? []).map((one) =>
        optionValue(conn.id, one.id),
      ),
    );
    return { values, suggested: values.length > 0 };
  }

  const rows = projects.map((project) => {
    const start = initial(project);
    const values = edits[project.id] ?? start.values;
    return {
      project,
      values,
      suggested: edits[project.id] === undefined && start.suggested,
      changed: !sameSet(values, current(project.id)),
    };
  });
  const changed = rows.filter((row) => row.changed);

  async function save(): Promise<void> {
    if (changed.length === 0) return;
    setSaving(true);
    try {
      for (const row of changed) {
        const next: ErrorProjectLink[] = row.values.flatMap((value) => {
          const found = remoteByValue.get(value);
          if (!found) return [];
          return [
            {
              projectId: row.project.id,
              connectionId: found.connectionId,
              remoteProjectId: found.project.id,
              remoteSlug: found.project.slug,
              remoteName: found.project.name,
            },
          ];
        });
        await window.runova.errorTracking.setLinks(row.project.id, next);
      }
      setEdits({});
      toast.success(changed.length === 1 ? 'Link saved' : 'Links saved');
      void queryClient.invalidateQueries({ queryKey: queryKeys.errorTracking });
      onSaved?.();
    } catch (error) {
      toast.error('Could not save the links', {
        description: ipcErrorMessage(error, 'Something went wrong.'),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className={cn('space-y-3', className)}>
      <div className="space-y-1">
        <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Link className="h-3.5 w-3.5 text-primary" />
          {title}
        </h3>
        <p className="text-xs text-muted-foreground">
          {description ??
            'Pick the Sentry projects that hold each project’s errors. The likely ones are picked for you; check them before you save.'}
        </p>
      </div>

      {remote.errors.length > 0 && (
        <Notice tone="warning" size="sm">
          Could not list the Sentry projects:{' '}
          {ipcErrorMessage(remote.errors[0]?.error, 'Something went wrong.')}
        </Notice>
      )}

      <ul className="divide-y divide-foreground/[0.06]">
        {rows.map((row) => (
          <li
            key={row.project.id}
            className="grid gap-2 py-2.5 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:items-center"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{row.project.name}</p>
              {row.suggested ? (
                <p className="text-[11px] text-primary">Suggested from the project name</p>
              ) : (
                row.project.folderPath && (
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {row.project.folderPath}
                  </p>
                )
              )}
            </div>
            {remote.isLoading ? (
              <Skeleton className="h-9 w-full rounded-full" />
            ) : (
              <MultiCombobox
                ariaLabel={`Sentry projects for ${row.project.name}`}
                options={options}
                values={row.values}
                onChange={(values) => setEdits((all) => ({ ...all, [row.project.id]: values }))}
                placeholder="Not linked"
                searchPlaceholder="Search Sentry projects…"
                emptyText="No Sentry project matches."
              />
            )}
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-end gap-2">
        {changed.length > 0 && (
          <span className={SECTION_HEADING}>
            {changed.length} project{changed.length === 1 ? '' : 's'} to update
          </span>
        )}
        <Button size="sm" disabled={saving || changed.length === 0} onClick={() => void save()}>
          {saving && <Spinner className="animate-spin" />}
          Save links
        </Button>
      </div>
    </section>
  );
}
