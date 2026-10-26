import type { ContainerSummary } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import {
  CircleCheck,
  CircleX,
  Pause,
  Spinner,
  StopCircle,
  TriangleAlert,
} from '@/components/icons';
import { Chip, type ChipTone } from '@/components/pageKit';
import { HEALTH_LABEL, STATE_LABEL, stateTone } from '@/lib/deploy/containers/list';
import { cn } from '@/lib/utils';

/**
 * A container's state in words with its own mark (E06 T8), never by colour alone: running,
 * running but unhealthy, paused, restarting, exited and the rest.
 */

/** The page kit's chip tones, which tint without a border the global border colour would repaint. */
const CHIP_TONE: Record<ReturnType<typeof stateTone>, ChipTone> = {
  good: 'success',
  busy: 'warning',
  idle: 'neutral',
  bad: 'destructive',
};

export function StateChip({
  container,
  className,
}: {
  container: Pick<ContainerSummary, 'state' | 'health'>;
  className?: string;
}): React.JSX.Element {
  const tone = stateTone(container);
  const health = container.state === 'running' ? HEALTH_LABEL[container.health] : null;
  const Icon =
    tone === 'good'
      ? CircleCheck
      : tone === 'bad'
        ? container.state === 'dead'
          ? CircleX
          : TriangleAlert
        : tone === 'busy'
          ? Spinner
          : container.state === 'paused'
            ? Pause
            : StopCircle;
  const label =
    health && health !== 'Healthy'
      ? `${STATE_LABEL[container.state]}, ${health.toLowerCase()}`
      : STATE_LABEL[container.state];
  return (
    <Chip tone={CHIP_TONE[tone]} className={className} data-state={container.state}>
      <Icon className={cn(tone === 'busy' && 'motion-safe:animate-spin')} />
      <span>{label}</span>
    </Chip>
  );
}
