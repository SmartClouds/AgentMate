import type { UiProInstallMethod } from '@runova/core';
import {
  buildUiProCommandPlan,
  UI_UX_PRO_MAX_AI_TARGETS,
  UI_UX_PRO_MAX_ALL_AGENTS,
  UI_UX_PRO_MAX_NPM_PACKAGE,
  UI_UX_PRO_MAX_PLUGIN_COMMANDS,
  UI_UX_PRO_MAX_PYTHON_URL,
  UI_UX_PRO_MAX_SKILL_NAME,
} from '@runova/core';
import type { UiProToolProbe } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheck,
  Copy,
  ExternalLink,
  Globe,
  Search,
  Spinner,
  TerminalSquare,
  TriangleAlert,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useTerminalStore } from '@/stores/terminalStore';

type WizardStep = 'method' | 'assistants' | 'location' | 'review';

const METHODS: {
  value: UiProInstallMethod;
  label: string;
  badge?: string;
  description: string;
}[] = [
  {
    value: 'npm-global',
    label: 'npm CLI',
    badge: 'Recommended',
    description: `Installs ${UI_UX_PRO_MAX_NPM_PACKAGE} once with npm, then runs "uipro init" wherever you want the skill. The README calls this the supported route: the CLI generates each assistant's files from templates.`,
  },
  {
    value: 'npx',
    label: 'npx, nothing installed globally',
    description:
      'Runs the same CLI straight from npm every time. Use this when a global npm install would need permissions you would rather not hand out.',
  },
  {
    value: 'claude-plugin',
    label: 'Claude Code plugin marketplace',
    description:
      'Two slash commands typed inside Claude Code. Claude Code only, and versions before 2.5.1 fail on symlinks in the zip.',
  },
];

const MODE_LABELS: Record<string, string> = {
  skill: 'Auto-activates',
  workflow: '/ui-ux-pro-max',
  both: 'Auto + slash command',
};

/**
 * PowerShell 5.1 (the default shell on Windows here) has no `&&`, so chained commands are joined
 * with `;`, which every shell this app can open understands.
 */
function joinCommands(commands: string[]): string {
  return commands.join('; ');
}

function ProbeRow({
  label,
  probe,
  hint,
  onFix,
  fixLabel,
}: {
  label: string;
  probe: UiProToolProbe;
  hint: string;
  onFix?: () => void;
  fixLabel?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5 text-sm">
      {probe.found ? (
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {label}
          {probe.found && probe.version && (
            <span className="ml-1.5 font-normal text-muted-foreground">{probe.version}</span>
          )}
          {!probe.found && <span className="ml-1.5 font-normal text-warning">not found</span>}
        </p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {!probe.found && onFix && (
        <Button variant="soft" size="sm" onClick={onFix}>
          <ExternalLink className="h-3.5 w-3.5" /> {fixLabel}
        </Button>
      )}
    </div>
  );
}

function CommandBlock({
  title,
  commands,
  onRun,
  runLabel,
}: {
  title: string;
  commands: string[];
  onRun?: () => void;
  runLabel?: string;
}): React.JSX.Element {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-medium text-muted-foreground">{title}</p>
        <div className="flex shrink-0 items-center gap-1">
          <SimpleTooltip label="Copy">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                void navigator.clipboard.writeText(commands.join('\n'));
                toast.success('Copied to clipboard.');
              }}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </SimpleTooltip>
          {onRun && (
            <Button variant="soft" size="sm" onClick={onRun}>
              <TerminalSquare className="h-3.5 w-3.5" /> {runLabel ?? 'Run'}
            </Button>
          )}
        </div>
      </div>
      {commands.map((command) => (
        <p key={command} className="break-all font-mono text-xs text-foreground">
          {command}
        </p>
      ))}
    </div>
  );
}

export function UiUxProMaxWizard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const openTerminalSession = useTerminalStore((s) => s.openSession);

  const [step, setStep] = useState<WizardStep>('method');
  const [method, setMethod] = useState<UiProInstallMethod>('npm-global');
  const [agents, setAgents] = useState<Set<string>>(new Set(['claude']));
  const [everyAssistant, setEveryAssistant] = useState(false);
  const [projectIds, setProjectIds] = useState<Set<string>>(new Set());
  const [installGlobally, setInstallGlobally] = useState(true);
  const [projectSearch, setProjectSearch] = useState('');

  // Reset the whole wizard each time it opens, rather than leaving the last run's answers behind.
  useEffect(() => {
    if (!open) return;
    setStep('method');
    setMethod('npm-global');
    setAgents(new Set(['claude']));
    setEveryAssistant(false);
    setProjectIds(new Set());
    setInstallGlobally(true);
    setProjectSearch('');
  }, [open]);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
    enabled: open,
  });

  const prerequisitesQuery = useQuery({
    queryKey: queryKeys.uiProPrerequisites,
    queryFn: () => window.runova.skills.checkUiProPrerequisites(),
    enabled: open,
    staleTime: 60_000,
  });

  const filteredProjects = useMemo(() => {
    const projects = projectsQuery.data ?? [];
    const q = projectSearch.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.folderPath.toLowerCase().includes(q),
    );
  }, [projectsQuery.data, projectSearch]);

  const selectedAgents = useMemo(
    () => (everyAssistant ? [UI_UX_PRO_MAX_ALL_AGENTS] : [...agents]),
    [everyAssistant, agents],
  );
  const isPluginMethod = method === 'claude-plugin';
  const steps: WizardStep[] = isPluginMethod
    ? ['method', 'review']
    : ['method', 'assistants', 'location', 'review'];
  const stepIndex = Math.max(0, steps.indexOf(step));

  const plan = useMemo(
    () => buildUiProCommandPlan({ method, agents: selectedAgents, global: false }),
    [method, selectedAgents],
  );

  const prerequisites = prerequisitesQuery.data;
  /** The CLI is already there, so the npm install step is only an update. */
  const cliAlreadyInstalled = method === 'npm-global' && prerequisites?.uipro.found === true;

  /** One entry per place the skill gets installed: the selected projects, plus the global scope. */
  const targets = useMemo(() => {
    const projectById = new Map((projectsQuery.data ?? []).map((p) => [p.id, p]));
    const list: { id: string | null; label: string; cwd?: string; commands: string[] }[] = [];
    for (const projectId of projectIds) {
      const project = projectById.get(projectId);
      if (!project) continue;
      list.push({
        id: project.id,
        label: `${project.name} · ${project.folderPath}`,
        cwd: project.folderPath,
        commands: buildUiProCommandPlan({ method, agents: selectedAgents, global: false }).install,
      });
    }
    if (installGlobally) {
      list.push({
        id: null,
        label: 'Global · every project on this machine',
        commands: buildUiProCommandPlan({ method, agents: selectedAgents, global: true }).install,
      });
    }
    return list;
  }, [projectsQuery.data, projectIds, installGlobally, method, selectedAgents]);

  const runMutation = useMutation({
    mutationFn: async () => {
      if (plan.setup.length > 0 && !cliAlreadyInstalled) {
        openTerminalSession({
          title: 'Install uipro CLI',
          initialInput: joinCommands(plan.setup),
        });
      }
      const recorded: (string | null)[] = [];
      for (const target of targets) {
        openTerminalSession({
          title: `UI UX Pro Max · ${target.id === null ? 'global' : target.label.split(' · ')[0]}`,
          initialInput: joinCommands(target.commands),
          cwd: target.cwd,
          projectId: target.id ?? undefined,
        });
        await window.runova.skills.recordUiProInstall({
          projectId: target.id,
          agents: selectedAgents,
          method,
        });
        recorded.push(target.id);
      }
      return recorded;
    },
    onSuccess: (recorded) => {
      for (const target of recorded) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.installedSkills(target) });
      }
      toast.info(
        recorded.length === 1
          ? 'Press Enter in the terminal to run the install.'
          : `Press Enter in each of the ${recorded.length + (plan.setup.length > 0 && !cliAlreadyInstalled ? 1 : 0)} terminals, starting with the CLI install.`,
      );
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function toggleAgent(value: string): void {
    setAgents((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function toggleProject(projectId: string): void {
    setProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  const canContinue =
    step === 'method' ||
    (step === 'assistants' && selectedAgents.length > 0) ||
    (step === 'location' && targets.length > 0) ||
    step === 'review';

  const selectedNotes = UI_UX_PRO_MAX_AI_TARGETS.filter(
    (target) => target.note && (everyAssistant || agents.has(target.value)),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Install UI UX Pro Max</DialogTitle>
          <DialogDescription>
            {step === 'method' && 'Pick how the uipro CLI should reach your machine.'}
            {step === 'assistants' && 'Pick the AI assistants that should get the skill.'}
            {step === 'location' && 'Pick the projects, or install once for every project.'}
            {step === 'review' && 'Check the commands, then run them in a terminal.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1.5">
          {steps.map((s, i) => (
            <div
              key={s}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                i <= stepIndex ? 'bg-primary' : 'bg-border',
              )}
            />
          ))}
        </div>

        <div className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1 py-1">
          {step === 'method' &&
            METHODS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                onClick={() => setMethod(entry.value)}
                className={cn(
                  'w-full rounded-lg border px-3 py-3 text-left transition-colors',
                  method === entry.value
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border bg-card/60 hover:bg-card',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {entry.label}
                  {entry.badge && <Badge variant="default">{entry.badge}</Badge>}
                  {method === entry.value && <Check className="ml-auto h-4 w-4 text-primary" />}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {entry.description}
                </span>
              </button>
            ))}

          {step === 'assistants' && (
            <>
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                  everyAssistant
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border bg-card/60 hover:bg-card',
                )}
              >
                <Checkbox
                  checked={everyAssistant}
                  onCheckedChange={(checked) => setEveryAssistant(checked === true)}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-foreground">Every assistant</span>
                  <span className="truncate text-xs text-muted-foreground">
                    Runs the install once with --ai all
                  </span>
                </span>
              </label>

              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {UI_UX_PRO_MAX_AI_TARGETS.map((target) => {
                  const checked = everyAssistant || agents.has(target.value);
                  return (
                    <label
                      key={target.value}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors',
                        everyAssistant
                          ? 'cursor-not-allowed border-border bg-muted/40 opacity-60'
                          : checked
                            ? 'cursor-pointer border-primary/60 bg-primary/10'
                            : 'cursor-pointer border-border bg-card/60 hover:bg-card',
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={everyAssistant}
                        onCheckedChange={() => toggleAgent(target.value)}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium text-foreground">
                          {target.label}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {MODE_LABELS[target.mode]}
                          {target.skillDir ? ` · ${target.skillDir}` : ''}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              {selectedNotes.length > 0 && (
                <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-3">
                  {selectedNotes.map((target) => (
                    <p key={target.value} className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{target.label}:</span>{' '}
                      {target.note}
                    </p>
                  ))}
                </div>
              )}
            </>
          )}

          {step === 'location' && (
            <>
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                  installGlobally
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-border bg-card/60 hover:bg-card',
                )}
              >
                <Checkbox
                  checked={installGlobally}
                  onCheckedChange={(checked) => setInstallGlobally(checked === true)}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <Globe className="h-3.5 w-3.5" /> Install globally
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    Adds --global, which writes to ~/.claude/skills and the equivalent folder for
                    each other assistant
                  </span>
                </span>
              </label>

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 z-10 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Search projects…"
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                {filteredProjects.map((project) => {
                  const checked = projectIds.has(project.id);
                  return (
                    <label
                      key={project.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                        checked
                          ? 'border-primary/60 bg-primary/10'
                          : 'border-border bg-card/60 hover:bg-card',
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleProject(project.id)}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium text-foreground">
                          {project.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {project.folderPath}
                        </span>
                      </span>
                    </label>
                  );
                })}
                {filteredProjects.length === 0 && (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {projectsQuery.data?.length === 0
                      ? 'No projects yet. You can still install globally.'
                      : 'No projects match your search.'}
                  </p>
                )}
              </div>
            </>
          )}

          {step === 'review' && (
            <>
              <div className="space-y-2.5 rounded-lg border border-border bg-card/60 p-3">
                <p className="text-sm font-medium">Prerequisites</p>
                {prerequisitesQuery.isPending ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="h-3.5 w-3.5 animate-spin" /> Checking your machine…
                  </p>
                ) : (
                  prerequisites && (
                    <>
                      {!isPluginMethod && (
                        <ProbeRow
                          label="npm"
                          probe={prerequisites.npm}
                          hint={
                            method === 'npx'
                              ? 'npx ships with npm, which is what runs the CLI here.'
                              : 'Needed for the global CLI install.'
                          }
                          fixLabel="Get Node.js"
                          onFix={() => void window.runova.shell.openExternal('https://nodejs.org/')}
                        />
                      )}
                      <ProbeRow
                        label={prerequisites.pythonCommand ?? 'python3'}
                        probe={prerequisites.python}
                        hint="The skill's search and design-system scripts run on Python 3. Standard library only, nothing extra to install."
                        fixLabel="Get Python"
                        onFix={() =>
                          void window.runova.shell.openExternal(UI_UX_PRO_MAX_PYTHON_URL)
                        }
                      />
                      {method === 'npm-global' && prerequisites.uipro.found && (
                        <ProbeRow
                          label="uipro"
                          probe={prerequisites.uipro}
                          hint="Already installed, so the npm step just updates it to the latest release."
                        />
                      )}
                    </>
                  )
                )}
              </div>

              {isPluginMethod ? (
                <>
                  <CommandBlock
                    title="Type these inside Claude Code"
                    commands={UI_UX_PRO_MAX_PLUGIN_COMMANDS}
                  />
                  <p className="text-xs text-muted-foreground">
                    These are Claude Code slash commands, not shell commands, so Runova cannot run
                    them for you. Copy them into a Claude Code session. If the install fails with
                    "Zip file contains a symbolic link", go back and use the npm CLI instead.
                  </p>
                </>
              ) : (
                <>
                  {plan.setup.length > 0 && (
                    <CommandBlock
                      title={cliAlreadyInstalled ? 'Update the CLI (optional)' : 'Install the CLI'}
                      commands={plan.setup}
                      runLabel="Run first"
                      onRun={() =>
                        openTerminalSession({
                          title: 'Install uipro CLI',
                          initialInput: joinCommands(plan.setup),
                        })
                      }
                    />
                  )}
                  {targets.map((target) => (
                    <CommandBlock
                      key={target.id ?? 'global'}
                      title={target.label}
                      commands={target.commands}
                      onRun={() =>
                        openTerminalSession({
                          title: `UI UX Pro Max · ${target.id === null ? 'global' : target.label.split(' · ')[0]}`,
                          initialInput: joinCommands(target.commands),
                          cwd: target.cwd,
                          projectId: target.id ?? undefined,
                        })
                      }
                    />
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Each command is typed into its own terminal tab without running, so you can read
                    it first and press Enter yourself. Run the CLI install before the init commands.
                    Afterwards the skill lives in{' '}
                    <span className="font-mono">{`<assistant>/skills/${UI_UX_PRO_MAX_SKILL_NAME}`}</span>
                    .
                  </p>
                </>
              )}
            </>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            disabled={stepIndex === 0}
            onClick={() => setStep(steps[stepIndex - 1])}
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          {step === 'review' ? (
            isPluginMethod ? (
              <Button
                onClick={() => {
                  void navigator.clipboard.writeText(UI_UX_PRO_MAX_PLUGIN_COMMANDS.join('\n'));
                  toast.success('Both commands copied. Paste them into Claude Code.');
                  onOpenChange(false);
                }}
              >
                <Copy className="h-4 w-4" /> Copy both commands
              </Button>
            ) : (
              <Button
                disabled={runMutation.isPending || targets.length === 0}
                onClick={() => runMutation.mutate()}
              >
                {runMutation.isPending ? (
                  <Spinner className="h-4 w-4 animate-spin" />
                ) : (
                  <TerminalSquare className="h-4 w-4" />
                )}
                Open {targets.length} terminal{targets.length === 1 ? '' : 's'}
              </Button>
            )
          ) : (
            <Button disabled={!canContinue} onClick={() => setStep(steps[stepIndex + 1])}>
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
