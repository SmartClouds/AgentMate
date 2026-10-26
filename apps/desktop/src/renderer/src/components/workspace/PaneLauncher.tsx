import type { Project } from '@runova/core';
import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { CliLogo } from '@/components/cliLogos';
import { Download, GitBranch, Globe, Sparkles, TerminalSquare } from '@/components/icons';
import { Chip, EmptyState, GLASS_CARD, SECTION_HEADING } from '@/components/pageKit';
import { ProjectIcon } from '@/components/projects/ProjectIcon';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useLauncherStore, usePromptDialogStore } from '@/lib/workspace/commands';
import { launchAgentTab, launchShellTab, shellOptions } from '@/lib/workspace/launch';
import type { WorkspaceProject } from '@/lib/workspace/scope';
import { useCliStore } from '@/stores/cliStore';
import { useShortcutLabel } from '@/stores/shortcutStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useAgentChoices } from './useAgentChoices';

/**
 * A launcher tile: a glass card that lifts and gains a soft primary ring on hover, like the
 * project and CLI cards. The edge is a ring, since `.glass` folds ring shadows into its own and
 * a tinted border would lose to the global border colour.
 */
const TILE = cn(
  GLASS_CARD,
  'group relative text-left transition-[box-shadow,transform] duration-150 hover:-translate-y-px hover:ring-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:hover:translate-y-0',
);

/** The logo tile on an agent card, drawn like the one on the CLI manager's cards. */
const LOGO_TILE =
  'flex shrink-0 items-center justify-center bg-foreground/[0.05] ring-1 ring-inset ring-foreground/[0.06]';

/** The agent grid follows the pane's width (the launcher is a container), not the window's. */
const AGENT_GRID_HERO = 'grid-cols-2 @lg:grid-cols-3';
const AGENT_GRID_PANE = 'grid-cols-1 @sm:grid-cols-2';

/** A shell or browser pill. The icon is a touch smaller than the button's default, to suit its 12px label. */
const SHELL_PILL = 'gap-1.5 [&_svg]:size-3.5';

/** How many not-installed agents show as icons before the rest fold into a "+N" link. */
const MISSING_SHOWN = 8;

/** The digit or shortcut hint on a tile, drawn like the command palette's key hint. */
const KEY_HINT =
  'inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground/[0.07] px-1.5 font-sans text-[10px] font-medium leading-none tabular-nums text-muted-foreground';

export interface PaneLauncherProps {
  project: Project;
  groupId: string;
  /** The whole workspace is empty, so this is the page's welcome, not just one spare pane. */
  hero: boolean;
  /** This pane has keyboard focus, so digit keys launch from it. */
  focused: boolean;
}

/** What an empty pane shows: big, obvious ways to start an agent or a shell. */
export function PaneLauncher({
  project,
  groupId,
  hero,
  focused,
}: PaneLauncherProps): React.JSX.Element {
  const agents = useAgentChoices(project);
  const worktree = (project as Partial<WorkspaceProject>).worktree ?? null;
  const shells = shellOptions();
  const browserKey = useShortcutLabel('workspace.newBrowser');
  const promptKey = useShortcutLabel('workspace.buildPrompt');
  const menuOpen = useLauncherStore((s) => s.openForGroupId !== null);
  const hasLaunchDefaults = useCliStore((s) => Object.keys(s.cliLaunchDefaults).length > 0);
  const visibleAgents = useMemo(
    () => agents.installed.slice(0, hero ? 9 : 6),
    [agents.installed, hero],
  );

  useEffect(() => {
    if (!focused || menuOpen) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      const digit = /^Digit([1-9])$/.exec(event.code);
      const choice = digit ? visibleAgents[Number(digit[1]) - 1] : undefined;
      if (!choice) return;
      event.preventDefault();
      launchAgentTab(project, choice.cli.id, groupId, { skipLaunchDefaults: event.altKey });
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focused, menuOpen, visibleAgents, project, groupId]);

  return (
    // m-auto rather than items-center/justify-center: flex centering overflows above the
    // scroll origin when the pane is shorter than the content, which cuts off the header.
    // A container, so the grid follows the pane's width rather than the window's.
    <div className="@container flex h-full w-full overflow-y-auto p-6">
      <div
        className={cn('m-auto flex w-full flex-col items-center', hero ? 'max-w-2xl' : 'max-w-md')}
      >
        {hero ? (
          // w-full on the header and the path, so a long path truncates instead of spilling past a narrow pane.
          <div className="mb-7 flex w-full flex-col items-center text-center">
            <ProjectIcon
              iconDataUrl={project.iconDataUrl}
              bgColor={project.iconBgColor}
              iconColor={project.iconColor}
              className="h-14 w-14 rounded-2xl shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]"
              glyphClassName="h-6 w-6"
            />
            <h2 className="mt-4 text-lg font-semibold tracking-tight">{project.name}</h2>
            {worktree ? (
              // Several checkouts look alike, so say which one an agent started here works in.
              <Chip tone="primary" className="mt-2 h-6 gap-1.5 px-2.5">
                <GitBranch />
                <span className="text-muted-foreground">Worktree</span>
                <span className="font-mono">{worktree.branch ?? 'detached'}</span>
              </Chip>
            ) : null}
            <p className="mt-1 w-full max-w-md truncate font-mono text-xs text-muted-foreground">
              {project.folderPath}
            </p>
          </div>
        ) : null}

        <p className="mb-2.5 flex w-full items-center justify-between gap-2 px-0.5">
          <span className={SECTION_HEADING}>{hero ? 'Start an agent' : 'Open in this pane'}</span>
          {hasLaunchDefaults ? (
            <span className="text-[10px] text-muted-foreground/70">
              Alt+click: skip launch defaults
            </span>
          ) : null}
        </p>

        {agents.loading ? (
          // The same grid and card heights as the loaded cards, so nothing jumps when they land.
          <div className={cn('grid w-full gap-2', hero ? AGENT_GRID_HERO : AGENT_GRID_PANE)}>
            {Array.from({ length: hero ? 6 : 4 }, (_, i) => (
              <Skeleton
                key={i}
                className={cn('rounded-[calc(var(--radius)+2px)]', hero ? 'h-31' : 'h-12')}
              />
            ))}
          </div>
        ) : visibleAgents.length === 0 ? (
          <EmptyState
            card
            size="sm"
            icon={TerminalSquare}
            title="No agent CLIs installed yet"
            description="Install Claude Code, Codex, Gemini or another agent to run it here."
            action={
              <Button asChild variant="soft" size="sm">
                <Link to="/cli-manager">
                  <Download /> Open the CLI manager
                </Link>
              </Button>
            }
            className="w-full"
          />
        ) : (
          <div className={cn('grid w-full gap-2', hero ? AGENT_GRID_HERO : AGENT_GRID_PANE)}>
            {visibleAgents.map((choice, index) => {
              const keyHint = (
                <kbd
                  aria-hidden
                  className={cn(
                    KEY_HINT,
                    'shrink-0 transition-opacity',
                    focused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                  )}
                >
                  {index + 1}
                </kbd>
              );
              return (
                <button
                  key={choice.cli.id}
                  type="button"
                  aria-keyshortcuts={String(index + 1)}
                  onClick={(event) =>
                    launchAgentTab(project, choice.cli.id, groupId, {
                      skipLaunchDefaults: event.altKey,
                    })
                  }
                  className={cn(
                    TILE,
                    'flex min-w-0',
                    hero ? 'flex-col gap-3 p-4' : 'items-center gap-2.5 px-3 py-2.5',
                    choice.isDefault
                      ? 'ring-1 ring-primary/35 hover:ring-primary/55'
                      : 'hover:ring-primary/30',
                  )}
                >
                  {hero ? (
                    <>
                      <span className="flex w-full items-start justify-between gap-2">
                        <span className={cn(LOGO_TILE, 'h-9 w-9 rounded-lg')}>
                          <CliLogo cliId={choice.cli.id} className="h-5 w-5" />
                        </span>
                        {keyHint}
                      </span>
                      <span className="w-full min-w-0">
                        <span className="block truncate text-sm font-semibold">
                          {choice.cli.name}
                        </span>
                        {/* One fixed-height line either way, so every card in a row matches. */}
                        <span className="mt-1 flex h-5 min-w-0 items-center gap-1.5">
                          {choice.isDefault ? <Chip tone="primary">Default</Chip> : null}
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {choice.cli.executableNames[0]}
                          </span>
                        </span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className={cn(LOGO_TILE, 'h-7 w-7 rounded-md')}>
                        <CliLogo cliId={choice.cli.id} className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {choice.cli.name}
                      </span>
                      {choice.isDefault ? (
                        <Chip tone="primary" className="h-4 px-1.5 text-[10px]">
                          Default
                        </Chip>
                      ) : null}
                      {keyHint}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <button
          type="button"
          onClick={() => usePromptDialogStore.getState().open(project.id, groupId)}
          className={cn(
            TILE,
            'mt-2 flex w-full items-center gap-3 px-3.5 py-2.5 ring-1 ring-primary/25 hover:ring-primary/50',
          )}
        >
          {/* The tint sits on its own layer, since `.glass` paints its background outside a
              layer and a bg utility on the card itself would never show. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[inherit] bg-primary/[0.05] transition-colors group-hover:bg-primary/[0.09]"
          />
          <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary shadow-[0_0_18px_-6px_hsl(var(--primary)/0.7)]">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <span className="relative min-w-0 flex-1">
            <span className="block text-sm font-semibold">Build a prompt first</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              Turn a rough request into a prompt, then open it in an agent on the suggested model
            </span>
          </span>
          {promptKey ? (
            <kbd aria-hidden className={cn(KEY_HINT, 'relative shrink-0')}>
              {promptKey}
            </kbd>
          ) : null}
        </button>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">or open a shell</span>
          {shells.map((option) => (
            <Button
              key={option.shell}
              variant="soft"
              size="sm"
              onClick={() => launchShellTab(project, option.shell, groupId)}
              className={SHELL_PILL}
            >
              <TerminalSquare />
              {option.label}
            </Button>
          ))}
          {/* Only when the row fits on one line, since a wrapped row would start with it. */}
          <span aria-hidden className="mx-1 hidden h-4 w-px bg-foreground/10 @xl:block" />
          <SimpleTooltip
            label={browserKey ? `Open a web page, like your dev server (${browserKey})` : null}
          >
            <Button
              variant="soft"
              size="sm"
              onClick={() => useWorkspaceStore.getState().openBrowser(project.id, { groupId })}
              className={SHELL_PILL}
            >
              <Globe />
              Browser
            </Button>
          </SimpleTooltip>
        </div>

        {hero && agents.missing.length > 0 && agents.installed.length > 0 ? (
          // Faded and grey until hovered, so the agents that can't start yet stay quieter than the cards.
          <div className="mt-6 flex flex-wrap items-center justify-center gap-1.5">
            <span className="mr-1 text-[11px] text-muted-foreground/70">Not installed</span>
            {agents.missing.slice(0, MISSING_SHOWN).map((choice) => (
              <SimpleTooltip
                key={choice.cli.id}
                label={`${choice.cli.name} isn't installed. Install it from the AI CLI Manager.`}
              >
                <Button
                  asChild
                  variant="soft"
                  size="icon-sm"
                  className="opacity-60 grayscale transition hover:opacity-100 hover:grayscale-0 focus-visible:opacity-100 focus-visible:grayscale-0"
                >
                  <Link to="/cli-manager" aria-label={`Install ${choice.cli.name}`}>
                    <CliLogo cliId={choice.cli.id} className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </SimpleTooltip>
            ))}
            {agents.missing.length > MISSING_SHOWN ? (
              <SimpleTooltip
                label={`${agents.missing.length - MISSING_SHOWN} more agents you can install from the AI CLI Manager`}
              >
                <Button
                  asChild
                  variant="soft"
                  size="xs"
                  className="opacity-60 hover:opacity-100 focus-visible:opacity-100"
                >
                  <Link
                    to="/cli-manager"
                    aria-label={`${agents.missing.length - MISSING_SHOWN} more agents to install`}
                  >
                    +{agents.missing.length - MISSING_SHOWN}
                  </Link>
                </Button>
              </SimpleTooltip>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
