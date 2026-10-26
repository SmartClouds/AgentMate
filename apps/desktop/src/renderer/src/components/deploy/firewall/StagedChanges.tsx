import type {
  FirewallChange,
  FirewallRuleInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { X } from '@/components/icons';
import { FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { describeChange } from '@/lib/deploy/firewall/format';
import { cn } from '@/lib/utils';
import { SECURITY_CARD } from '../security/SecurityCard';

/**
 * What is about to change, one line each, until it is reviewed and applied as one change set.
 * Nothing here has reached the server yet.
 */

export function StagedChanges({
  changes,
  rules,
  onDrop,
  onDiscard,
  onReview,
}: {
  changes: FirewallChange[];
  rules: FirewallRuleInfo[];
  onDrop: (index: number) => void;
  onDiscard: () => void;
  onReview: () => void;
}): React.JSX.Element | null {
  if (changes.length === 0) return null;
  return (
    <section
      aria-label="Staged changes"
      // A primary edge marks the card as work in progress. It is a ring, since the global
      // colour would repaint a border.
      className={cn(SECURITY_CARD, 'ring-1 ring-inset ring-primary/35')}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <p className="flex items-center gap-2.5 text-sm font-medium text-foreground">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-primary" />
          <span>
            {changes.length === 1 ? '1 change staged' : `${changes.length} changes staged`}, not
            applied yet
          </span>
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="soft" onClick={onDiscard}>
            Discard
          </Button>
          <Button size="sm" onClick={onReview}>
            Review and apply
          </Button>
        </div>
      </div>
      <ul className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
        {changes.map((change, index) => {
          const words = describeChange(change, rules);
          return (
            // Staged changes have no id of their own, and order matters to the core.
            <li
              key={index}
              className="flex items-center gap-2 py-1.5 pl-4 pr-2.5 text-sm text-foreground"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{words}</span>
              <SimpleTooltip label="Take this change out">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Take out: ${words}`}
                  onClick={() => onDrop(index)}
                >
                  <X />
                </Button>
              </SimpleTooltip>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
