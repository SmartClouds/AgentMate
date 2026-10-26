import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { CliLogo } from '@/components/cliLogos';
import { ArrowDown, ArrowUp, GripVertical, RefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ReorderableGroup } from '@/components/ui/ReorderableGroup';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { orderedClis } from '@/components/workspace/useAgentChoices';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useCliStore } from '@/stores/cliStore';

/**
 * The order agents are offered in when launching one: the Workspace "+" menu, the tiles of an
 * empty pane, and the digit keys that pick them. Drag a row by its grip, or use the arrows.
 */
export function CliOrderSettings(): React.JSX.Element {
  const cliOrder = useCliStore((s) => s.cliOrder);
  const setCliOrder = useCliStore((s) => s.setCliOrder);
  const status = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
    staleTime: 5 * 60_000,
    // Same query as Launch defaults. The last observer to mount sets its meta, so both must opt out.
    meta: { silentLoading: true },
  });
  const installed = new Set((status.data ?? []).filter((c) => c.installed).map((c) => c.id));
  // Memoized so the list keeps the order it's dropped into until the store catches up.
  const clis = useMemo(() => orderedClis(cliOrder), [cliOrder]);

  function moveTo(from: number, to: number): void {
    const ids = clis.map((cli) => cli.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    setCliOrder(ids);
  }

  // Digit hints count installed agents only, since those are the ones a launcher lists.
  const digits = new Map<string, number>();
  let position = 0;
  for (const cli of clis) {
    if (installed.has(cli.id)) digits.set(cli.id, ++position);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Installed agents get number keys 1 to 9 in this order.
        </p>
        <Button variant="soft" disabled={cliOrder.length === 0} onClick={() => setCliOrder([])}>
          <RefreshCw /> Default order
        </Button>
      </div>
      <ReorderableGroup
        as="ol"
        items={clis}
        getId={(cli) => cli.id}
        enabled
        className="overflow-hidden rounded-lg border border-border/70"
        onMove={moveTo}
        renderItem={(cli, motion, index) => {
          const isInstalled = installed.has(cli.id);
          const digit = digits.get(cli.id) ?? null;
          return (
            <li
              {...motion.itemProps}
              className={cn(
                'relative flex h-10 items-center gap-3 border-b border-border/50 px-3 last:border-b-0',
                motion.dragging
                  ? 'z-10 bg-popover shadow-lg ring-1 ring-foreground/10 transition-none'
                  : 'bg-background/40 transition-transform duration-200 ease-out motion-reduce:transition-none',
              )}
            >
              <span
                onPointerDown={motion.onGripPointerDown}
                aria-hidden
                className="flex h-6 w-4 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground/60 active:cursor-grabbing"
              >
                <GripVertical className="h-3 w-3" />
              </span>
              <CliLogo cliId={cli.id} className="h-4 w-4" />
              <span
                className={cn('flex-1 truncate text-sm', !isInstalled && 'text-muted-foreground')}
              >
                {cli.name}
              </span>
              {isInstalled ? (
                digit !== null && digit <= 9 ? (
                  <kbd className="rounded border border-border/80 px-1.5 font-mono text-[10px] text-muted-foreground">
                    {digit}
                  </kbd>
                ) : null
              ) : (
                <span className="text-[11px] text-muted-foreground/70">Not installed</span>
              )}
              <span className="flex items-center gap-0.5">
                <SimpleTooltip label="Move up">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${cli.name} up`}
                    disabled={index === 0}
                    onClick={() => moveTo(index, index - 1)}
                  >
                    <ArrowUp />
                  </Button>
                </SimpleTooltip>
                <SimpleTooltip label="Move down">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${cli.name} down`}
                    disabled={index === clis.length - 1}
                    onClick={() => moveTo(index, index + 1)}
                  >
                    <ArrowDown />
                  </Button>
                </SimpleTooltip>
              </span>
            </li>
          );
        }}
      />
    </div>
  );
}
