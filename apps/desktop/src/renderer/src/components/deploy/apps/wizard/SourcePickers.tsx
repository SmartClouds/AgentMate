import { coreErrorMessage } from '@shared/coreErrors';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId } from 'react';
import { Field, Problem } from '@/components/cloudflare/fields';
import { FileCode, FileText } from '@/components/icons';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

/**
 * The compose file and environment pickers of an app's source, shared by the wizard's Source
 * step and the app page's Edit dialog.
 */

// Inset rings, since a tinted border would lose to the global border colour.
const CARD =
  'flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2 ring-1 ring-inset transition-colors';
const CARD_ON = 'bg-primary/12 ring-primary/40';
const CARD_OFF = 'ring-foreground/[0.08] hover:bg-foreground/[0.06]';

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export function useComposeFiles(projectId: string) {
  return useQuery({
    queryKey: queryKeys.deployComposeFiles(projectId),
    queryFn: () => window.runova.deployStacks.discover(projectId),
    enabled: projectId !== '',
    retry: false,
  });
}

export function useProjectEnvironments(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectEnvironments(projectId),
    queryFn: () => window.runova.environments.list(projectId),
    enabled: projectId !== '',
  });
}

export function ComposeFilePicker({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: string;
  onChange: (composePath: string) => void;
}): React.JSX.Element {
  const ids = useId();
  const discovery = useComposeFiles(projectId);
  const files = discovery.data?.files ?? [];

  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium text-foreground">Compose file</legend>
      {discovery.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : discovery.isError ? (
        <Problem
          message={`The project's compose files could not be listed: ${coreErrorMessage(discovery.error)}`}
          onRetry={() => void discovery.refetch()}
        />
      ) : files.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This project has no compose.yaml or docker-compose.yml. Add one to the project and come
          back.
        </p>
      ) : (
        <div role="radiogroup" aria-label="Compose file" className="space-y-1.5">
          {files.map((file) => {
            const unreadable = file.error !== undefined;
            const checked = value === file.path;
            return (
              <label
                key={file.path}
                className={cn(
                  CARD,
                  checked ? CARD_ON : CARD_OFF,
                  unreadable && 'cursor-not-allowed opacity-60',
                )}
              >
                <input
                  type="radio"
                  name={`${ids}-compose`}
                  value={file.path}
                  checked={checked}
                  disabled={unreadable}
                  onChange={() => onChange(file.path)}
                  className="mt-1 accent-[hsl(var(--primary))]"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-mono text-sm text-foreground">
                    <FileCode className="h-3 w-3 shrink-0 text-muted-foreground" />
                    {file.path}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {unreadable
                      ? file.error
                      : file.services === null
                        ? 'Services unknown'
                        : plural(file.services, 'service')}
                  </span>
                </span>
              </label>
            );
          })}
          {discovery.data?.truncated && (
            <p className="text-xs text-muted-foreground">
              The project is large, so a compose file deep inside it may be missing here.
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}

export interface EnvironmentPick {
  environmentId: string | null;
  environmentName: string | null;
  envFileIds: string[] | null;
}

/**
 * Which files of `all` are ticked: every one for null, and every one too when none of a
 * remembered pick is left (so a stale pick never strands anyone). An empty list stays empty.
 */
export function pickedEnvFiles(all: readonly string[], envFileIds: string[] | null): string[] {
  if (envFileIds === null) return [...all];
  const kept = all.filter((id) => envFileIds.includes(id));
  return kept.length === 0 && envFileIds.length > 0 ? [...all] : kept;
}

export function EnvironmentPicker({
  projectId,
  environmentId,
  envFileIds,
  onChange,
}: {
  projectId: string;
  environmentId: string | null;
  envFileIds: string[] | null;
  onChange: (next: EnvironmentPick) => void;
}): React.JSX.Element {
  const ids = useId();
  const environments = useProjectEnvironments(projectId);
  const environment = environments.data?.find((item) => item.id === environmentId);
  const files = environment?.files ?? [];
  const all = files.map((file) => file.id);
  const picked = pickedEnvFiles(all, envFileIds);
  const normalized = picked.length === all.length ? null : picked;

  // A remembered pick naming files the environment no longer has is brought in line with what
  // the list shows, so the preview never asks for a file that is gone.
  const stale = environment !== undefined && envFileIds !== null && envFileIds.length > 0;
  const differs = stale && JSON.stringify(normalized) !== JSON.stringify(envFileIds);
  useEffect(() => {
    if (differs && environment) {
      onChange({ environmentId, environmentName: environment.name, envFileIds: normalized });
    }
  }, [differs, environment, environmentId, normalized, onChange]);

  function toggle(id: string, on: boolean): void {
    if (!environment) return;
    const next = all.filter((item) => (item === id ? on : picked.includes(item)));
    onChange({
      environmentId,
      environmentName: environment.name,
      envFileIds: next.length === all.length ? null : next,
    });
  }

  return (
    <div className="space-y-3">
      <Field
        label="Environment"
        htmlFor={`${ids}-environment`}
        hint="The files you tick become the app's .env on the server. Values stay out of this window."
      >
        <Combobox
          id={`${ids}-environment`}
          searchable={false}
          options={[
            { value: '', label: 'No environment' },
            ...(environments.data ?? []).map((item) => ({
              value: item.id,
              label: `${item.name}${item.files.length === 0 ? ' (no files)' : ''}`,
            })),
          ]}
          value={environmentId ?? ''}
          disabled={environments.isPending}
          onChange={(next) => {
            const found = environments.data?.find((item) => item.id === next);
            onChange({
              environmentId: next === '' ? null : next,
              environmentName: found?.name ?? null,
              envFileIds: null,
            });
          }}
        />
      </Field>

      {environmentId !== null &&
        (environments.isPending ? (
          <Skeleton className="h-10 w-full rounded-xl" aria-busy="true" />
        ) : !environment ? null : files.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This environment has no files yet. Add them in the project's Environments tab.
          </p>
        ) : (
          <fieldset className="space-y-2">
            <legend className="sr-only">Env files</legend>
            <div className="flex items-baseline justify-between gap-3">
              <span aria-hidden="true" className="text-sm font-medium text-foreground">
                Env files
              </span>
              <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
                <span role="status">
                  {picked.length} of {plural(all.length, 'file')}
                </span>
                {picked.length < all.length && (
                  <button
                    type="button"
                    onClick={() =>
                      onChange({
                        environmentId,
                        environmentName: environment.name,
                        envFileIds: null,
                      })
                    }
                    className="cursor-pointer rounded font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Use all
                  </button>
                )}
              </span>
            </div>
            <ul aria-label="Env files" className="space-y-1.5">
              {files.map((file) => {
                const checked = picked.includes(file.id);
                return (
                  <li key={file.id}>
                    <label className={cn(CARD, 'items-center', checked ? CARD_ON : CARD_OFF)}>
                      <Checkbox
                        checked={checked}
                        aria-label={file.fileName}
                        onCheckedChange={(state) => toggle(file.id, state === true)}
                      />
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-sm text-foreground">
                        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="truncate">{file.fileName}</span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {plural(file.keyCount, 'key')}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {picked.length === 0 ? (
              <p className="text-xs text-destructive">
                Tick at least one file, or pick No environment.
              </p>
            ) : picked.length > 1 ? (
              <p className="text-xs text-muted-foreground">
                Applied top to bottom. A later file wins when a key repeats.
              </p>
            ) : null}
          </fieldset>
        ))}
    </div>
  );
}
