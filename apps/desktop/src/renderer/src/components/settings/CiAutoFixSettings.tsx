import { type AppSettings, CLI_REGISTRY, cliLaunchOptions, type EffortLevel } from '@runova/core';
import { AUTO_FIX_DEFAULT_ATTEMPTS, AUTO_FIX_MAX_ATTEMPTS } from '@shared/ciAutoFixTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EffortPicker } from '@/components/cli/RunSettingsFields';
import { cliOptionIcon } from '@/components/cliLogos';
import { Wand2 } from '@/components/icons';
import { Combobox } from '@/components/ui/combobox';
import { queryKeys } from '@/lib/queryKeys';

type AutoFixPatch = Partial<
  Pick<
    AppSettings,
    'ciAutoFixCliId' | 'ciAutoFixModel' | 'ciAutoFixEffort' | 'ciAutoFixMaxAttempts'
  >
>;

/** "Each project's CLI" in the picker, since a Combobox value is a string. */
const PROJECT_CLI = '';

const TRIES = Array.from({ length: AUTO_FIX_MAX_ATTEMPTS }, (_, i) => {
  const count = i + 1;
  return { value: String(count), label: `${count} ${count === 1 ? 'try' : 'tries'}` };
});

function FieldLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>;
}

/**
 * What CI auto-fix uses when it is switched on for a run: which agent, on which model and effort,
 * and how many fixes it pushes before giving up. Each run can still pick another agent.
 */
export function CiAutoFixSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
    meta: { silentLoading: true },
  });
  const save = useMutation({
    mutationFn: (patch: AutoFixPatch) => window.runova.settings.update(patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });

  // The control shows what was just picked until the saved value comes back.
  const saved = { ...settingsQuery.data, ...(save.isPending ? save.variables : {}) };
  const cliId = saved.ciAutoFixCliId ?? null;
  const model = saved.ciAutoFixModel ?? undefined;
  const effort = saved.ciAutoFixEffort ?? undefined;
  const maxAttempts = saved.ciAutoFixMaxAttempts ?? AUTO_FIX_DEFAULT_ATTEMPTS;
  const options = cliId ? cliLaunchOptions(cliId) : null;

  const installed = CLI_REGISTRY.filter(
    (cli) => cli.id === cliId || cliQuery.data?.find((entry) => entry.id === cli.id)?.installed,
  );

  return (
    <div className="space-y-4 px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Wand2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold leading-none">CI auto-fix</h3>
          <p className="text-sm text-muted-foreground">
            Switch it on for a run from Pipelines or a project's Git panel. If the run fails, this
            agent fixes it in a workspace tab, and Runova commits and pushes the fix to the same
            branch, then checks the next run.
          </p>
        </div>
      </div>

      <div className="grid gap-4 pl-12 sm:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>Agent</FieldLabel>
          <Combobox
            ariaLabel="Agent CLI for auto-fix"
            value={cliId ?? PROJECT_CLI}
            onChange={(next) =>
              save.mutate({
                ciAutoFixCliId: next || null,
                ciAutoFixModel: null,
                ciAutoFixEffort: null,
              })
            }
            searchable={false}
            options={[
              { value: PROJECT_CLI, label: "Each project's CLI" },
              ...installed.map((cli) => ({
                value: cli.id,
                label: cli.name,
                icon: cliOptionIcon(cli.id),
              })),
            ]}
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Tries per run</FieldLabel>
          <Combobox
            ariaLabel="Tries per run"
            value={String(maxAttempts)}
            onChange={(next) => save.mutate({ ciAutoFixMaxAttempts: Number(next) })}
            searchable={false}
            options={TRIES}
          />
        </div>

        {options && cliId ? (
          <>
            <div className="space-y-1.5">
              <FieldLabel>Model</FieldLabel>
              <Combobox
                ariaLabel="Model for auto-fix"
                value={model ?? ''}
                onChange={(next) =>
                  save.mutate({ ciAutoFixModel: next.trim() || null, ciAutoFixEffort: null })
                }
                options={options.models.map((m) => ({
                  value: m.value,
                  label: m.label,
                  keywords: [m.value],
                }))}
                placeholder="CLI default"
                searchPlaceholder="Search or type a model name…"
                emptyText="Type a model name to use it."
                customLabel={(text) => `Use "${text}"`}
                allowCustom
                clearable
              />
            </div>
            {options.efforts.length > 0 ? (
              <div className="space-y-1.5">
                <FieldLabel>Effort</FieldLabel>
                <EffortPicker
                  options={options}
                  model={model}
                  value={effort}
                  onChange={(next: EffortLevel | undefined) =>
                    save.mutate({ ciAutoFixEffort: next ?? null })
                  }
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
