import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Field } from '@/components/cloudflare/fields';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { ComposeFilePicker, EnvironmentPicker } from './SourcePickers';
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
                envFileIds: null,
              });
            }}
          />
        )}
      </Field>

      {source.projectId !== '' && (
        <ComposeFilePicker
          projectId={source.projectId}
          value={source.composePath}
          onChange={(composePath) => onChange({ composePath })}
        />
      )}

      {source.projectId !== '' && (
        <EnvironmentPicker
          projectId={source.projectId}
          environmentId={source.environmentId}
          envFileIds={source.envFileIds}
          onChange={onChange}
        />
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
