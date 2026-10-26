import {
  buildHealthSetupPrompt,
  buildHealthSpecMarkdown,
  HEALTH_DEFAULT_PATH,
  type HealthAuthMode,
  type Project,
} from '@runova/core';
import type { ProjectEnvironment } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { Plus, Sparkles, TerminalSquare } from '@/components/icons';
import { FOOTER_HAIRLINE, SECTION_WELL, SEGMENT_TRACK, segmentClass } from '@/components/pageKit';
import { ProjectIcon } from '@/components/projects/ProjectIcon';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { Field, FormSection } from './formParts';
import { TextPane, useSendToAgent } from './promptParts';

/**
 * "Build with AI" before any target exists: pick the project and where it runs, and get the
 * prompt that has the project's agent (Claude Code, say) build a secured endpoint that follows
 * the Runova Health Protocol. The prompt is built here as the fields change. It names the
 * server variables only; the key itself is made later, when a target is added.
 */

const QUIET = { silentLoading: true } as const;

const SIGN_IN: { mode: HealthAuthMode; label: string }[] = [
  { mode: 'bearer', label: 'Bearer key' },
  { mode: 'basic', label: 'HTTP Basic' },
];

/** What the user typed as the path, as one the endpoint can serve. */
function cleanPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return HEALTH_DEFAULT_PATH;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function projectIcon(project: Project, size: 'sm' | 'md'): React.ReactNode {
  return (
    <ProjectIcon
      iconDataUrl={project.iconDataUrl ?? null}
      bgColor={project.iconBgColor}
      iconColor={project.iconColor}
      className={size === 'sm' ? 'h-5 w-5 rounded' : 'h-8 w-8 rounded-lg'}
      glyphClassName={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'}
    />
  );
}

/** Stands in for the prompt until a project is picked, so the choice is the first thing seen. */
function ProjectChoices({
  projects,
  onPick,
}: {
  projects: readonly Project[];
  onPick: (projectId: string) => void;
}): React.JSX.Element {
  const headingId = useId();
  if (projects.length === 0) {
    return (
      <div
        className={cn(
          SECTION_WELL,
          'flex min-h-40 items-center justify-center text-sm text-muted-foreground',
        )}
      >
        No projects yet. Add one on the Projects page first.
      </div>
    );
  }
  return (
    <div className={cn(SECTION_WELL, 'space-y-3')}>
      <div className="space-y-0.5 px-1">
        <p id={headingId} className="text-sm font-medium">
          Which project is the endpoint for?
        </p>
        <p className="text-xs text-muted-foreground">
          The prompt is written for it, and its agent starts in its folder.
        </p>
      </div>
      <ul
        aria-labelledby={headingId}
        className="rail-scroll max-h-[40vh] space-y-0.5 overflow-y-auto"
      >
        {projects.map((one) => (
          <li key={one.id}>
            <button
              type="button"
              onClick={() => onPick(one.id)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {projectIcon(one, 'md')}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{one.name}</span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {one.folderPath}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HealthBuildDialog({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  lockProject = false,
  onAddTarget,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly Project[];
  defaultProjectId?: string;
  /** On a project's own tab the project is a given. */
  lockProject?: boolean;
  /** The next step: add a target for the project the prompt was built for. */
  onAddTarget: (projectId: string) => void;
}): React.JSX.Element {
  const baseId = useId();
  const id = (name: string) => `${baseId}-${name}`;
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [environmentId, setEnvironmentId] = useState('');
  const [serverLabel, setServerLabel] = useState('');
  const [authMode, setAuthMode] = useState<HealthAuthMode>('bearer');
  const [path, setPath] = useState(HEALTH_DEFAULT_PATH);
  const [tab, setTab] = useState<'prompt' | 'spec'>('prompt');

  // Each opening starts from the page's project, not from what was picked last time.
  useEffect(() => {
    if (!open) return;
    setProjectId(defaultProjectId ?? '');
    setEnvironmentId('');
    setServerLabel('');
    setAuthMode('bearer');
    setPath(HEALTH_DEFAULT_PATH);
    setTab('prompt');
  }, [open, defaultProjectId]);

  const project = projects.find((one) => one.id === projectId);
  const environments = useQuery({
    queryKey: queryKeys.projectEnvironments(projectId),
    queryFn: async (): Promise<ProjectEnvironment[]> =>
      (await window.runova.environments.list(projectId)) ?? [],
    enabled: open && Boolean(projectId),
    meta: QUIET,
  });
  const projectEnvironments = projectId ? (environments.data ?? []) : [];
  const environment = projectEnvironments.find((one) => one.id === environmentId);

  const prompt = useMemo(
    () =>
      project
        ? buildHealthSetupPrompt({
            projectName: project.name,
            environmentName: environment?.name ?? null,
            serverLabel: serverLabel.trim() || null,
            path: cleanPath(path),
            authMode,
          })
        : null,
    [project, environment?.name, serverLabel, path, authMode],
  );
  const spec = useMemo(() => buildHealthSpecMarkdown(), []);
  const agent = useSendToAgent(project);

  function send(): void {
    if (prompt && agent.send(prompt)) onOpenChange(false);
  }

  function pickProject(value: string): void {
    if (value !== projectId) setEnvironmentId('');
    setProjectId(value);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-[min(56rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0">
        <DialogHeader className="px-5 py-4 pr-12 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Build the endpoint with AI
          </DialogTitle>
          <DialogDescription className="text-xs">
            Your agent reads the project, finds every service it uses, and adds a secured health
            endpoint that follows the Runova Health Protocol. Then add a target for it and set the
            key's hash on the server.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto px-5 py-4 md:grid-cols-[17rem_minmax(0,1fr)]">
          <FormSection title="For">
            <Field id={id('project')} label="Project">
              <Combobox
                id={id('project')}
                value={projectId}
                disabled={lockProject}
                placeholder="Pick a project"
                searchPlaceholder="Search projects…"
                emptyText="No project matches."
                onChange={pickProject}
                options={projects.map((one) => ({
                  value: one.id,
                  label: one.name,
                  keywords: [one.folderPath],
                  icon: projectIcon(one, 'sm'),
                }))}
              />
            </Field>
            <Field id={id('environment')} label="Environment" optional>
              <Combobox
                id={id('environment')}
                value={environmentId}
                disabled={!projectId}
                searchPlaceholder="Search environments…"
                emptyText="No environment matches."
                onChange={setEnvironmentId}
                options={[
                  { value: '', label: 'Any environment' },
                  ...projectEnvironments.map((env) => ({ value: env.id, label: env.name })),
                ]}
              />
            </Field>
            <Field id={id('server')} label="Server" optional>
              <Input
                id={id('server')}
                value={serverLabel}
                placeholder="web-1"
                autoComplete="off"
                onChange={(event) => setServerLabel(event.target.value)}
              />
            </Field>
            <div className="space-y-1.5">
              <span id={id('sign-in')} className="text-sm font-medium">
                Sign-in
              </span>
              <div
                role="group"
                aria-labelledby={id('sign-in')}
                className={cn(SEGMENT_TRACK, 'w-full')}
              >
                {SIGN_IN.map((option) => (
                  <button
                    key={option.mode}
                    type="button"
                    aria-pressed={authMode === option.mode}
                    onClick={() => setAuthMode(option.mode)}
                    className={cn(segmentClass(authMode === option.mode), 'flex-1')}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <Field id={id('path')} label="Path" hint="Where the endpoint lives in the app.">
              <Input
                id={id('path')}
                value={path}
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
                onChange={(event) => setPath(event.target.value)}
                aria-describedby={`${id('path')}-hint`}
              />
            </Field>
          </FormSection>

          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as 'prompt' | 'spec')}
            className="min-w-0"
          >
            <TabsList>
              <TabsTrigger value="prompt">Prompt</TabsTrigger>
              <TabsTrigger value="spec">Protocol</TabsTrigger>
            </TabsList>
            <TabsContent value="prompt" className="mt-3">
              {prompt ? (
                <TextPane
                  text={prompt}
                  copyLabel="Copy prompt"
                  copyWhat="Prompt"
                  label="Prompt for your agent"
                />
              ) : (
                <ProjectChoices projects={projects} onPick={pickProject} />
              )}
            </TabsContent>
            <TabsContent value="spec" className="mt-3">
              <TextPane text={spec} copyLabel="Copy protocol" copyWhat="Protocol" />
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter
          className={cn(
            FOOTER_HAIRLINE,
            'flex-row items-center gap-2 px-5 py-3 sm:justify-between',
          )}
        >
          <Button
            variant="soft"
            size="sm"
            disabled={!projectId}
            onClick={() => {
              onOpenChange(false);
              onAddTarget(projectId);
            }}
          >
            <Plus />
            Add target
          </Button>
          <div className="flex min-w-0 items-center gap-3">
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              {project ? (
                <>
                  Opens in <span className="font-medium text-foreground">{project.name}</span>
                </>
              ) : (
                'Pick a project first'
              )}
            </p>
            <Button size="sm" disabled={!prompt} onClick={send} className="shrink-0">
              <TerminalSquare />
              Send to {agent.cliName ?? 'agent'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
