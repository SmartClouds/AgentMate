import {
  type LaunchPick,
  launchPickArgs,
  launchPickLabel,
  launchPickOptions,
  type Project,
} from '@agentmat/core';
import { useNavigate } from 'react-router-dom';
import { CliLogo } from '@/components/cliLogos';
import { Globe, Keyboard, SettingsIcon, Sparkles, TerminalSquare } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useLauncherStore, usePromptDialogStore } from '@/lib/workspace/commands';
import { launchAgentTab, launchShellTab, shellOptions } from '@/lib/workspace/launch';
import { useCliStore } from '@/stores/cliStore';
import { useShortcutLabel } from '@/stores/shortcutStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { AgentSubmenu } from './AgentSubmenu';
import { useAgentChoices } from './useAgentChoices';

export interface LauncherMenuProps {
  project: Project;
  groupId: string;
  children: React.ReactElement;
  align?: 'start' | 'end';
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <DropdownMenuShortcut className="pl-3">{children}</DropdownMenuShortcut>;
}

/** The "+" menu of a pane: start an agent or a shell in it. Digits pick the first nine agents. */
export function LauncherMenu({
  project,
  groupId,
  children,
  align = 'start',
}: LauncherMenuProps): React.JSX.Element {
  const navigate = useNavigate();
  const open = useLauncherStore((s) => s.openForGroupId === groupId);
  const setOpenFor = useLauncherStore((s) => s.setOpenFor);
  const agents = useAgentChoices(project);
  const shells = shellOptions();
  const browserKey = useShortcutLabel('workspace.newBrowser');
  const promptKey = useShortcutLabel('workspace.buildPrompt');
  const launchDefaults = useCliStore((s) => s.cliLaunchDefaults);
  const hasLaunchDefaults = Object.keys(launchDefaults).length > 0;

  const launchAgent = (cliId: string, skipLaunchDefaults = false, pick?: LaunchPick): void => {
    launchAgentTab(project, cliId, groupId, {
      skipLaunchDefaults,
      runArgs: pick ? launchPickArgs(cliId, pick) : undefined,
      runLabel: pick ? launchPickLabel(cliId, pick) : undefined,
    });
  };

  return (
    <DropdownMenu open={open} onOpenChange={(next) => setOpenFor(next ? groupId : null)}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        // Wide enough for "Claude Code CLI", the Default chip, a digit and the flyout arrow.
        className="w-[17rem]"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          // A flyout is portaled out of this menu, but its key presses still bubble up to here.
          if (!event.currentTarget.contains(event.target as Node)) return;
          const digit = /^Digit([1-9])$/.exec(event.code);
          const choice = digit ? agents.installed[Number(digit[1]) - 1] : undefined;
          if (!choice || event.ctrlKey || event.metaKey) return;
          event.preventDefault();
          setOpenFor(null);
          launchAgent(choice.cli.id, event.altKey);
        }}
      >
        <DropdownMenuItem
          onSelect={() => usePromptDialogStore.getState().open(project.id, groupId)}
          className="mb-1 bg-primary/[0.07] text-primary focus:bg-primary/15 focus:text-primary"
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span className="font-medium">Build a prompt…</span>
          {promptKey ? (
            <Kbd>{promptKey}</Kbd>
          ) : (
            <span className="ml-auto text-[10px] text-primary/70">then run it</span>
          )}
        </DropdownMenuItem>
        <DropdownMenuLabel className="flex items-center justify-between gap-2">
          <span>Agents</span>
          {hasLaunchDefaults ? (
            <span className="font-normal normal-case tracking-normal text-muted-foreground/70">
              Alt+click: skip launch defaults
            </span>
          ) : null}
        </DropdownMenuLabel>
        {agents.loading ? (
          <div className="space-y-1 px-2.5 py-1">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-4/5" />
          </div>
        ) : agents.installed.length === 0 ? (
          <p className="px-2.5 pb-2 text-xs leading-relaxed text-muted-foreground">
            No agent CLIs found on this machine yet.
          </p>
        ) : (
          agents.installed.map((choice, index) => {
            const pickOptions = launchPickOptions(choice.cli.id);
            const hint = index < 9 ? <Kbd>{index + 1}</Kbd> : null;
            return pickOptions ? (
              <AgentSubmenu
                key={choice.cli.id}
                choice={choice}
                options={pickOptions}
                saved={launchDefaults[choice.cli.id]}
                trailing={hint}
                onLaunch={(pick, skip) => launchAgent(choice.cli.id, skip, pick)}
                onClose={() => setOpenFor(null)}
              />
            ) : (
              <DropdownMenuItem
                key={choice.cli.id}
                onSelect={() => launchAgent(choice.cli.id)}
                onClick={(event) => {
                  if (!event.altKey) return;
                  event.preventDefault();
                  setOpenFor(null);
                  launchAgent(choice.cli.id, true);
                }}
              >
                <CliLogo cliId={choice.cli.id} className="h-4 w-4" />
                <span className="truncate">{choice.cli.name}</span>
                {choice.isDefault ? (
                  <Chip tone="primary" className="h-4 px-1.5 text-[10px]">
                    Default
                  </Chip>
                ) : null}
                {hint}
              </DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Shells</DropdownMenuLabel>
        {shells.map((option) => (
          <DropdownMenuItem
            key={option.shell}
            onSelect={() => launchShellTab(project, option.shell, groupId)}
          >
            <TerminalSquare className="h-3.5 w-3.5 text-muted-foreground" />
            {option.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => useWorkspaceStore.getState().openBrowser(project.id, { groupId })}
        >
          <Globe className="h-3.5 w-3.5 text-muted-foreground" />
          Browser
          {browserKey ? <Kbd>{browserKey}</Kbd> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/cli-manager')}>
          <SettingsIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Manage CLIs</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/settings?tab=shortcuts')}>
          <Keyboard className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Keyboard shortcuts</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
