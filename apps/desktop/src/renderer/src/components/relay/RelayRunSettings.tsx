import {
  cliLaunchOptions,
  EFFORT_LABELS,
  type EffortLevel,
  formatTokenCount,
  type Project,
  RELAY_BUDGET_CHOICES,
  type RelayRunChoice,
  type RelayTaskOverride,
  relayCapabilities,
} from '@agentmat/core';
import type { RelayProjectSettings, RelaySettingsPatch } from '@shared/relayTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { CliLogo } from '@/components/cliLogos';
import { Check, Minus } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useAgentChoices } from '@/components/workspace/useAgentChoices';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { choiceFor, cliName, planFirstFor } from './relayView';

const DEFAULT_VALUE = '';

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium">{label}</div>
        {hint ? <div className="text-[11px] leading-snug text-muted-foreground">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Two or more options side by side, the way the app's segmented pickers look. */
function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-full bg-foreground/[0.06] p-0.5"
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'cursor-pointer rounded-full px-2.5 py-0.5 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            option.value === value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Capability({
  on,
  children,
}: {
  on: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className={cn('flex items-start gap-1.5', !on && 'text-muted-foreground/70')}>
      {on ? (
        <Check aria-label="Available" className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
      ) : (
        <Minus aria-label="Not available" className="mt-0.5 h-3 w-3 shrink-0" />
      )}
      <span>{children}</span>
    </li>
  );
}

/** What this CLI can and cannot do in a relay, so nobody waits for a ring a CLI never reports. */
export function RelayCapabilityList({ cliId }: { cliId: string }): React.JSX.Element {
  const caps = relayCapabilities(cliId);
  return (
    <ul
      aria-label={`What the relay can do with ${cliName(cliId)}`}
      className="space-y-1 text-[11.5px]"
    >
      <Capability on={caps.planAutoSwitch}>
        Approves a finished plan and starts the work by itself
      </Capability>
      <Capability on={caps.contextGuard !== 'none'}>
        Tells the session to hand off when its context runs low
        {caps.contextGuard === 'mcp' ? ' (the session asks AgentMate)' : ''}
      </Capability>
      <Capability on={caps.stopGate}>
        Keeps the session going until its handoff is written
      </Capability>
      <Capability on={caps.contextMeter}>Shows how full the context is, live</Capability>
      <Capability on={caps.completion === 'exact'}>
        Knows the moment a session stops
        {caps.completion === 'exact' ? '' : ' (waits for it to go quiet)'}
      </Capability>
    </ul>
  );
}

interface RelayRunSettingsProps {
  projectId: string;
  project: Project | null;
  settings: RelayProjectSettings;
  /** Set to edit one task's override; unset edits what every task runs with. */
  taskId?: string;
  children: React.ReactNode;
  align?: 'start' | 'center' | 'end';
}

/**
 * The run choice for every task, or for one, plus the relay's options. Each change is saved as it
 * is made, so the popover never has a stale "Save" to forget.
 */
export function RelayRunSettings({
  projectId,
  project,
  settings,
  taskId,
  children,
  align = 'end',
}: RelayRunSettingsProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-[22rem] p-0">
        {open ? (
          <RelayRunSettingsForm
            projectId={projectId}
            project={project}
            settings={settings}
            taskId={taskId}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function RelayRunSettingsForm({
  projectId,
  project,
  settings,
  taskId,
}: Omit<RelayRunSettingsProps, 'children' | 'align'>): React.JSX.Element {
  const queryClient = useQueryClient();
  const agents = useAgentChoices(project);
  const choice = taskId ? choiceFor(settings, taskId) : settings.defaults;
  const planFirst = taskId ? planFirstFor(settings, taskId) : settings.options.planFirst;
  const override = taskId ? settings.overrides[taskId] : undefined;
  const caps = relayCapabilities(choice.cliId);
  const launch = cliLaunchOptions(choice.cliId);

  async function save(patch: RelaySettingsPatch): Promise<void> {
    try {
      const next = await window.agentmat.relay.saveSettings(projectId, patch);
      queryClient.setQueryData(queryKeys.relayBoard(projectId), (board: unknown) =>
        board && typeof board === 'object' ? { ...board, settings: next } : board,
      );
    } catch (error) {
      toast.error('Could not save the relay settings', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function setChoice(change: Partial<RelayRunChoice> & { planFirst?: boolean }): void {
    if (taskId) {
      const next: RelayTaskOverride = { ...override, ...change };
      void save({ overrides: { ...settings.overrides, [taskId]: next } });
      return;
    }
    const { planFirst: nextPlan, ...rest } = change;
    void save({
      ...(Object.keys(rest).length > 0 ? { defaults: { ...settings.defaults, ...rest } } : {}),
      ...(nextPlan !== undefined ? { options: { planFirst: nextPlan } } : {}),
    });
  }

  const cliOptions: ComboboxOption[] = agents.installed.map((agent) => ({
    value: agent.cli.id,
    label: agent.cli.name,
    icon: <CliLogo cliId={agent.cli.id} className="h-3.5 w-3.5" />,
  }));
  if (!cliOptions.some((option) => option.value === choice.cliId)) {
    cliOptions.unshift({ value: choice.cliId, label: cliName(choice.cliId) });
  }
  const models = launch?.models ?? [];
  const model = models.find((entry) => entry.value === choice.model);
  const efforts: readonly EffortLevel[] = model?.efforts ?? launch?.efforts ?? [];

  return (
    <div className="divide-y divide-border/60">
      <div className="px-4 pt-3.5 pb-2">
        <p className="text-[10px] font-semibold tracking-[0.12em] text-primary uppercase">
          {taskId ? `Run settings for ${taskId}` : 'Run settings for every task'}
        </p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          {taskId
            ? 'This task runs with these instead of the relay defaults.'
            : 'A task can still have its own choice, set from its card.'}
        </p>
      </div>

      <div className="px-4 py-2">
        <Row label="Agent">
          <Combobox
            ariaLabel="Agent"
            className="w-44"
            options={cliOptions}
            value={choice.cliId}
            onChange={(cliId) => cliId && setChoice({ cliId, model: null, effort: null })}
          />
        </Row>
        <Row label="Pick per task" hint="Sizes each task first, like Build Prompt does.">
          <Switch
            aria-label="Pick model and effort per task"
            checked={choice.autoSize}
            onCheckedChange={(autoSize) => setChoice({ autoSize })}
          />
        </Row>
        {!choice.autoSize && models.length > 0 ? (
          <>
            <Row label="Model">
              <Combobox
                ariaLabel="Model"
                className="w-44"
                options={[
                  { value: DEFAULT_VALUE, label: 'CLI default' },
                  ...models.map((entry) => ({ value: entry.value, label: entry.label })),
                ]}
                value={choice.model ?? DEFAULT_VALUE}
                onChange={(value) => setChoice({ model: value || null })}
              />
            </Row>
            {efforts.length > 0 ? (
              <Row label="Effort">
                <Combobox
                  ariaLabel="Effort"
                  className="w-44"
                  options={[
                    { value: DEFAULT_VALUE, label: 'CLI default' },
                    ...efforts.map((level) => ({ value: level, label: EFFORT_LABELS[level] })),
                  ]}
                  value={choice.effort ?? DEFAULT_VALUE}
                  onChange={(value) => setChoice({ effort: value || null })}
                />
              </Row>
            ) : null}
          </>
        ) : null}
        <Row
          label="Plan first"
          hint={
            caps.planMode
              ? caps.planAutoSwitch
                ? 'Plans, then starts the work by itself when nothing is left to ask.'
                : 'Plans, then waits for you to approve the plan in its tab.'
              : undefined
          }
        >
          <SimpleTooltip
            label={caps.planMode ? null : `${cliName(choice.cliId)} has no plan mode.`}
            wrapTrigger
          >
            <Switch
              aria-label="Plan first"
              checked={planFirst && caps.planMode}
              disabled={!caps.planMode}
              onCheckedChange={(next) => setChoice({ planFirst: next })}
            />
          </SimpleTooltip>
        </Row>
        {taskId && override ? (
          <div className="pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const { [taskId]: _removed, ...rest } = settings.overrides;
                void save({ overrides: rest });
              }}
            >
              Use the relay defaults
            </Button>
          </div>
        ) : null}
      </div>

      {taskId ? null : (
        <div className="px-4 py-2">
          {caps.planAutoSwitch ? (
            <Row label="After the plan">
              <Segmented
                label="After the plan"
                value={settings.options.afterPlanMode}
                options={[
                  { value: 'auto', label: 'Auto mode' },
                  { value: 'acceptEdits', label: 'Accept edits' },
                ]}
                onChange={(afterPlanMode) => void save({ options: { afterPlanMode } })}
              />
            </Row>
          ) : null}
          <Row label="Context budget" hint="Per session. Past 80% the session hands off.">
            <Segmented
              label="Context budget"
              value={settings.options.defaultBudget}
              options={RELAY_BUDGET_CHOICES.map((value) => ({
                value,
                label: formatTokenCount(value),
              }))}
              onChange={(defaultBudget) => void save({ options: { defaultBudget } })}
            />
          </Row>
          <Row label="Commit when done" hint="One commit per task, only its own files.">
            <Switch
              aria-label="Commit when done"
              checked={settings.options.commitPerTask}
              onCheckedChange={(commitPerTask) => void save({ options: { commitPerTask } })}
            />
          </Row>
          <Row label="Close finished tabs">
            <Switch
              aria-label="Close finished tabs"
              checked={settings.options.closeFinishedTabs}
              onCheckedChange={(closeFinishedTabs) => void save({ options: { closeFinishedTabs } })}
            />
          </Row>
          <Row label="When a task is stuck" hint="Blocked, or its tests fail.">
            <Segmented
              label="When a task is stuck"
              value={settings.options.whenStuck}
              options={[
                { value: 'pause', label: 'Pause' },
                { value: 'continue', label: 'Keep going' },
              ]}
              onChange={(whenStuck) => void save({ options: { whenStuck } })}
            />
          </Row>
        </div>
      )}

      <div className="bg-foreground/[0.025] px-4 py-3">
        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <CliLogo cliId={choice.cliId} className="h-3 w-3" /> With {cliName(choice.cliId)}
        </p>
        <RelayCapabilityList cliId={choice.cliId} />
      </div>
    </div>
  );
}
