import type { HealthState } from '@runova/core';
import { Chip } from '@/components/pageKit';
import { HEALTH_STATE_META } from './healthView';

/** A target's state as a tinted chip: a dot and the word, so it never rests on colour. */
export function HealthStatusChip({
  state,
  className,
}: {
  state: HealthState;
  className?: string;
}): React.JSX.Element {
  const meta = HEALTH_STATE_META[state];
  return (
    <Chip tone={meta.tone} dot pulse={state === 'pending'} className={className}>
      {meta.label}
    </Chip>
  );
}
