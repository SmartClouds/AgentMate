import type { AgentStatus } from '@runova/core';
import { Chip, type ChipTone } from '@/components/pageKit';
import { cn } from '@/lib/utils';

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'Working',
  'needs-input': 'Needs your input',
  done: 'Finished',
  idle: 'Idle',
  exited: 'Exited',
};

/**
 * A small mark for what an agent is doing: a spinning ring while it works, a pulsing amber
 * dot when it waits on you, a solid green dot when it finished and you have not looked yet.
 * Idle and exited show nothing.
 */
export function AgentStatusDot({
  status,
  className,
}: {
  status: AgentStatus | null;
  className?: string;
}): React.JSX.Element | null {
  if (status === 'working') {
    // The ring's colours are inline, since the global unlayered border colour beats any
    // border colour utility and left the spinner a plain grey circle.
    return (
      <span
        role="img"
        aria-label={AGENT_STATUS_LABEL.working}
        style={{
          borderColor: 'hsl(var(--primary) / 0.2)',
          borderTopColor: 'hsl(var(--primary))',
        }}
        className={cn(
          'block h-3 w-3 shrink-0 animate-spin rounded-full border-2 shadow-[0_0_6px_hsl(var(--primary)/0.45)] motion-reduce:animate-none',
          className,
        )}
      />
    );
  }
  if (status === 'needs-input') {
    return (
      <span
        role="img"
        aria-label={AGENT_STATUS_LABEL['needs-input']}
        className={cn('relative flex h-2 w-2 shrink-0', className)}
      >
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-warning shadow-[0_0_6px_hsl(var(--warning))]" />
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span
        role="img"
        aria-label={AGENT_STATUS_LABEL.done}
        className={cn(
          'block h-2 w-2 shrink-0 rounded-full bg-primary shadow-[0_0_6px_hsl(var(--primary))]',
          className,
        )}
      />
    );
  }
  return null;
}

const STATUS_TONE: Partial<Record<AgentStatus, ChipTone>> = {
  working: 'primary',
  'needs-input': 'warning',
  done: 'success',
};

/**
 * The same state in words, as a tinted chip, for places with room for a label such as a tab's
 * tooltip. Idle and exited show nothing, like the dot.
 */
export function AgentStatusChip({
  status,
  className,
}: {
  status: AgentStatus | null;
  className?: string;
}): React.JSX.Element | null {
  const tone = status ? STATUS_TONE[status] : undefined;
  if (!status || !tone) return null;
  return (
    <Chip tone={tone} dot pulse={status !== 'done'} className={className}>
      {AGENT_STATUS_LABEL[status]}
    </Chip>
  );
}
