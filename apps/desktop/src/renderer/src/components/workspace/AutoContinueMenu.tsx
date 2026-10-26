import type { AutoContinuePending } from '@runova/core';
import { useState } from 'react';
import { Play } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useAutoContinuePending } from '@/stores/agentStatusStore';
import { useWorkspaceStore, type WorkspaceTerminalTab } from '@/stores/workspaceStore';

/** "3:05 PM" today, "Sat 3:05 PM" on another day. */
function formatFireAt(fireAt: number): string {
  const at = new Date(fireAt);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

export function autoContinuePendingLine(pending: AutoContinuePending): string {
  const when = formatFireAt(pending.fireAt);
  return pending.kind === 'limit'
    ? `Usage limit hit. Sending "continue" at ${when}`
    : `Network error. Sending "continue" at ${when} (try ${pending.attempt})`;
}

export interface AutoContinueMenuProps {
  projectId: string;
  tab: WorkspaceTerminalTab;
}

/**
 * Per-tab switches that have Runova type "continue" for the agent once its usage limit
 * resets, or a few minutes after it stopped on a network error.
 */
export function AutoContinueMenu({ projectId, tab }: AutoContinueMenuProps): React.JSX.Element {
  const setAutoContinue = useWorkspaceStore((s) => s.setAutoContinue);
  const pending = useAutoContinuePending(tab.id);
  const [open, setOpen] = useState(false);
  const afterLimit = Boolean(tab.autoContinue?.afterLimitReset);
  const afterNetwork = Boolean(tab.autoContinue?.afterNetworkError);
  const enabled = afterLimit || afterNetwork;
  const label = pending
    ? autoContinuePendingLine(pending)
    : enabled
      ? 'Auto-continue is on'
      : 'Auto-continue';

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <SimpleTooltip label={label}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Auto-continue"
            className={cn(
              'relative data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground',
              enabled && 'text-primary hover:text-primary',
            )}
          >
            <Play />
            {pending ? (
              <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
            ) : null}
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent
        align="end"
        className="w-72"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuLabel>Auto-continue this agent</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={afterLimit}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(checked) =>
            setAutoContinue(projectId, tab.id, { afterLimitReset: checked })
          }
        >
          <span className="flex flex-col gap-0.5">
            <span>After the usage limit resets</span>
            <span className="text-xs text-muted-foreground">
              Waits for the reset time the agent shows, then sends "continue".
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={afterNetwork}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(checked) =>
            setAutoContinue(projectId, tab.id, { afterNetworkError: checked })
          }
        >
          <span className="flex flex-col gap-0.5">
            <span>After a network error</span>
            <span className="text-xs text-muted-foreground">
              Internet, DNS or connection drops. Sends "continue" after 3 minutes, waiting longer
              each time it fails again.
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        {pending ? (
          <>
            <DropdownMenuSeparator />
            <p className="px-2.5 py-1.5 text-xs text-foreground">
              {autoContinuePendingLine(pending)}
            </p>
            <DropdownMenuItem onSelect={() => void window.runova.agents.cancelAutoContinue(tab.id)}>
              Cancel this time
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
