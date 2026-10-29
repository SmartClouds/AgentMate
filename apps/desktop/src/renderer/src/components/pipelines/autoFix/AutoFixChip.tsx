import type { AutoFixSession } from '@shared/ciAutoFixTypes';
import { Wand2 } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { cn } from '@/lib/utils';
import { phaseView } from './autoFixView';

/** Where an auto-fix session stands, as a chip with a wand so it reads as auto-fix at a glance. */
export function AutoFixChip({
  session,
  className,
}: {
  session: AutoFixSession;
  className?: string;
}): React.JSX.Element {
  const view = phaseView(session);
  return (
    <Chip tone={view.tone} dot={view.pulse} pulse={view.pulse} className={cn('gap-1', className)}>
      {view.pulse ? null : <Wand2 />}
      {view.label}
    </Chip>
  );
}
