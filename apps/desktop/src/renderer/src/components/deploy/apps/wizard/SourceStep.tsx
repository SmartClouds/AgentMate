import { coreErrorMessage } from '@shared/coreErrors';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Field, Problem } from '@/components/cloudflare/fields';
import { FileCode } from '@/components/icons';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import type { WizardSource } from './types';

/** Where the app comes from: a project, one of its compose files, an environment, and a name. */

export function SourceStep({
  source,
  nameProblem,
  nameLocked,
  onChange,
}: {
  source: WizardSource;
  nameProblem: string | null;
  /** Deploying again keeps the app's name. */
  nameLocked: boolean;
  onChange: (next: Partial<WizardSource>, touchedName?: boolean) => void;
}): React.JSX.Element {
  const ids = useId();
  const projects = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  });
  const discovery = useQuery({
    queryKey: queryKeys.deployComposeFiles(source.projectId),
    queryFn: () => window.runova.deployStacks.discover(source.projectId),
    enabled: source.projectId !== '',
    retry: false,
  });
  const environments = useQuery({
    queryKey: queryKeys.projectEnvironments(source.projectId),
    queryFn: () => window.runova.environments.list(source.projectId),
    enabled: source.projectId !== '',
  });

  const files = discovery.data?.files ?? [];

  return (
    <div className="space-y-5">
      <Field label="Project" htmlFor={`${ids}-project`}>
        {projects.isPending ? (
          <Skeleton className="h-9 w-full rounded-full" aria-busy="true" />
        ) : (
          <Combobox
            id={`${ids}-project`}
            options={(projects.data ?? []).map((project) => ({
              value: project.id,
              label: project.name,
            }))}
            value={source.projectId}
            placeholder="Pick a project"
            searchPlaceholder="Search projects…"
            emptyText="No project matches."
            onChange={(projectId) => {
              const project = projects.data?.find((item) => item.id === projectId);
              onChange({
                projectId,
                projectName: project?.name ?? '',
                projectFolder: project?.folderPath ?? '',
                composePath: '',
                environmentId: null,
              });
            }}
          />
        )}
      </Field>

      {source.projectId !== '' && (
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
              This project has no compose.yaml or docker-compose.yml. Add one to the project and
              come back.
            </p>
          ) : (
            <div role="radiogroup" aria-label="Compose file" className="space-y-1.5">
              {files.map((file) => {
                const unreadable = file.error !== undefined;
                const checked = source.composePath === file.path;
                return (
                  <label
                    key={file.path}
                    className={cn(
                      // Inset rings, since a tinted border would lose to the global border colour.
                      'flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2 ring-1 ring-inset transition-colors',
                      checked
                        ? 'bg-primary/12 ring-primary/40'
                        : 'ring-foreground/[0.08] hover:bg-foreground/[0.06]',
                      unreadable && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <input
                      type="radio"
                      name={`${ids}-compose`}
                      value={file.path}
                      checked={checked}
                      disabled={unreadable}
                      onChange={() => onChange({ composePath: file.path })}
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
                            : file.services === 1
                              ? '1 service'
                              : `${file.services} services`}
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
      )}

      {source.projectId !== '' && (
        <Field
          label="Environment"
          htmlFor={`${ids}-environment`}
          hint="Its files become the app's .env on the server. Values stay out of this window."
        >
          <Combobox
            id={`${ids}-environment`}
            searchable={false}
            options={[
              { value: '', label: 'No environment' },
              ...(environments.data ?? []).map((environment) => ({
                value: environment.id,
                label: `${environment.name}${environment.files.length === 0 ? ' (no files)' : ''}`,
              })),
            ]}
            value={source.environmentId ?? ''}
            disabled={environments.isPending}
            onChange={(environmentId) => {
              const environment = environments.data?.find((item) => item.id === environmentId);
              onChange({
                environmentId: environmentId === '' ? null : environmentId,
                environmentName: environment?.name ?? null,
              });
            }}
          />
        </Field>
      )}

      <Field
        label="App name"
        htmlFor={`${ids}-name`}
        hint={
          nameLocked
            ? 'Deploying again keeps the name.'
            : 'The compose project name on the server: lowercase letters, digits, dashes and underscores.'
        }
      >
        <Input
          id={`${ids}-name`}
          value={source.name}
          readOnly={nameLocked}
          aria-invalid={nameProblem !== null}
          aria-describedby={nameProblem ? `${ids}-name-problem` : undefined}
          onChange={(event) => onChange({ name: event.target.value }, true)}
          className="font-mono"
          spellCheck={false}
        />
        {nameProblem && (
          <p id={`${ids}-name-problem`} className="text-xs text-destructive">
            {nameProblem}
          </p>
        )}
      </Field>
    </div>
  );
}
