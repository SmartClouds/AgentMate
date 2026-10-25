import type { GithubRunner, RunnerMachineLink, SshSavedServer } from '@shared/apiTypes';
import { useNavigate } from 'react-router-dom';
import { Cpu, LinkOff, Plus } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const LOCAL = 'local';

function linkValue(link: RunnerMachineLink | undefined): string {
  if (!link) return '';
  return link.kind === 'local' ? LOCAL : link.serverId;
}

/** A saved server whose nickname, or host name before the domain, is the runner's name. */
function matchesRunner(server: SshSavedServer, runnerName: string): boolean {
  const name = runnerName.toLowerCase();
  return server.nickname.toLowerCase() === name || server.host.toLowerCase().split('.')[0] === name;
}

function Suggested(): React.JSX.Element {
  return <span className="ml-auto pl-2 text-[10px] text-muted-foreground">Suggested</span>;
}

/**
 * Picks the machine a runner runs on, so its tile can show that machine's CPU, memory and disk.
 * GitHub does not say which machine a runner is, so a saved server that shares its name is only
 * offered first, never linked on its own.
 */
export function RunnerMachineLinkMenu({
  runner,
  link,
  servers,
  onChange,
}: {
  runner: GithubRunner;
  link: RunnerMachineLink | undefined;
  servers: SshSavedServer[];
  onChange: (link: RunnerMachineLink | null) => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const label = link ? 'Change the machine' : 'Show CPU, memory and disk';
  const ordered = [...servers].sort(
    (a, b) => Number(matchesRunner(b, runner.name)) - Number(matchesRunner(a, runner.name)),
  );

  return (
    <DropdownMenu>
      <SimpleTooltip label={label}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn('-my-1 -mr-1.5 h-5 w-5 shrink-0', link && 'text-primary')}
            aria-label={`${label} of ${runner.name}`}
          >
            <Cpu />
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Which machine is {runner.name} on?</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={linkValue(link)}
          onValueChange={(value) =>
            onChange(value === LOCAL ? { kind: 'local' } : { kind: 'ssh', serverId: value })
          }
        >
          <DropdownMenuRadioItem value={LOCAL}>
            This computer
            {runner.onThisComputer ? <Suggested /> : null}
          </DropdownMenuRadioItem>
          {ordered.map((server) => (
            <DropdownMenuRadioItem key={server.id} value={server.id}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{server.nickname}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {`${server.username}@${server.host}`}
                </span>
              </span>
              {matchesRunner(server, runner.name) ? <Suggested /> : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate('/remote')}>
          <Plus className="h-3.5 w-3.5" />
          {servers.length === 0 ? 'Save an SSH server in Remote' : 'Add another SSH server'}
        </DropdownMenuItem>
        {link ? (
          <DropdownMenuItem onSelect={() => onChange(null)}>
            <LinkOff className="h-3.5 w-3.5" />
            Stop showing stats
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
