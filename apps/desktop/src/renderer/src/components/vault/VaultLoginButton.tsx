import type { Project, VaultEntrySummary } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ExternalLink,
  SignIn,
  Spinner,
  WindowMaximize,
  Workspace,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { loginUrlOf, resolveLoginChoice, runOneClickLogin } from '@/lib/vault/oneClickLogin';
import { useVaultStore, type VaultLoginChoice } from '@/stores/vaultStore';

function describe(choice: VaultLoginChoice, host: string, project?: Project): string {
  switch (choice.kind) {
    case 'window':
      return `Opens ${host} in a Runova window and fills in your login`;
    case 'workspace':
      return `Opens ${host} in a browser tab of ${project?.name ?? 'the project'} and fills in your login`;
    case 'system':
      return `Opens ${host} in your browser and copies the password`;
  }
}

/**
 * One-click login for an entry: opens its website and enters the username and password. The
 * `full` button in the detail pane has a menu to pick where; the `icon` one in a list row uses
 * whatever was picked last.
 */
export function VaultLoginButton({
  entry,
  variant,
  className,
}: {
  entry: VaultEntrySummary;
  variant: 'full' | 'icon';
  className?: string;
}): React.JSX.Element | null {
  const navigate = useNavigate();
  const remembered = useVaultStore((s) => s.loginTarget);
  const setLoginTarget = useVaultStore((s) => s.setLoginTarget);
  const [busy, setBusy] = useState(false);
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
    meta: { silentLoading: true },
  });
  const projects = projectsQuery.data ?? [];

  const url = loginUrlOf(entry);
  if (!url) return null;
  const host = entry.host || new URL(url).hostname;
  // A project that was removed since it was picked falls back to the login window.
  const choice = resolveLoginChoice(remembered, projectsQuery.data);
  const project =
    choice.kind === 'workspace' ? projects.find((p) => p.id === choice.projectId) : undefined;

  async function run(target: VaultLoginChoice): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await runOneClickLogin({ entry, choice: target, navigate });
    } finally {
      setBusy(false);
    }
  }

  function pick(target: VaultLoginChoice): void {
    setLoginTarget(target);
    void run(target);
  }

  const label = `Log in to ${host}`;
  const icon = busy ? <Spinner className="animate-spin" /> : <SignIn />;

  if (variant === 'icon') {
    return (
      <SimpleTooltip label={describe(choice, host, project)}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          className={className}
          onClick={(event) => {
            event.stopPropagation();
            void run(choice);
          }}
        >
          {icon}
        </Button>
      </SimpleTooltip>
    );
  }

  return (
    <div className={cn('inline-flex items-stretch', className)}>
      <SimpleTooltip label={describe(choice, host, project)}>
        <Button
          aria-label={label}
          disabled={busy}
          onClick={() => void run(choice)}
          className="rounded-r-none bg-gradient-to-b from-emerald-500 to-emerald-600 text-white shadow-[0_0_24px_-8px_rgb(16_185_129/0.8)] hover:from-emerald-500 hover:to-emerald-500"
        >
          {icon}
          Log in
        </Button>
      </SimpleTooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Choose where to log in"
            disabled={busy}
            className="rounded-l-none border-l border-white/25 bg-emerald-600 px-1.5 text-white hover:bg-emerald-500"
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>Log in to {host} with</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={choice.kind}>
            <DropdownMenuRadioItem value="window" onSelect={() => pick({ kind: 'window' })}>
              <WindowMaximize className="h-3.5 w-3.5 text-emerald-500" />
              <span className="flex flex-col">
                <span>Runova window</span>
                <span className="text-[11px] text-muted-foreground">
                  Fills in your login{entry.autoSubmit ? ' and signs you in' : ''}
                </span>
              </span>
            </DropdownMenuRadioItem>
            {projects.length > 0 ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  className={cn(choice.kind === 'workspace' && 'font-medium text-foreground')}
                >
                  <Workspace className="h-3.5 w-3.5 text-sky-500" />
                  <span className="flex flex-col">
                    <span>Workspace tab</span>
                    <span className="text-[11px] text-muted-foreground">
                      {choice.kind === 'workspace' && project
                        ? `In ${project.name}`
                        : 'A browser tab in a project'}
                    </span>
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                  <DropdownMenuRadioGroup
                    value={choice.kind === 'workspace' ? choice.projectId : ''}
                  >
                    {projects.map((option) => (
                      <DropdownMenuRadioItem
                        key={option.id}
                        value={option.id}
                        onSelect={() => pick({ kind: 'workspace', projectId: option.id })}
                      >
                        {option.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuItem disabled>
                <Workspace className="h-3.5 w-3.5" />
                <span className="flex flex-col">
                  <span>Workspace tab</span>
                  <span className="text-[11px]">Add a project to use its browser</span>
                </span>
              </DropdownMenuItem>
            )}
            <DropdownMenuRadioItem value="system" onSelect={() => pick({ kind: 'system' })}>
              <ExternalLink className="h-3.5 w-3.5 text-violet-500" />
              <span className="flex flex-col">
                <span>Default browser</span>
                <span className="text-[11px] text-muted-foreground">
                  Opens the site and copies the password
                </span>
              </span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
            Runova only fills pages on {host}. Your choice is remembered for next time.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
