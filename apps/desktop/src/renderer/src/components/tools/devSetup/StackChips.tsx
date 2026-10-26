import type { DevStack } from '@runova/core';
import { Lock } from '@/components/icons';
import { FilterChip, GLASS_CARD } from '@/components/pageKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { STACK_ICONS } from './stackIcons';

/**
 * "What do you build?" The checklist below only lists what the chosen stacks need, so this one
 * choice decides how long the page is. Essentials is always on and drawn as a plain label, not a
 * toggle, so nothing invites a click that could not do anything.
 */
export function StackChips({
  stacks,
  selected,
  onToggle,
}: {
  stacks: readonly DevStack[];
  selected: readonly string[];
  onToggle: (id: string) => void;
}): React.JSX.Element {
  return (
    <section aria-labelledby="dev-setup-stacks" className={cn(GLASS_CARD, 'p-4')}>
      <h2 id="dev-setup-stacks" className="text-sm font-semibold leading-tight">
        What do you build?
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Pick what you work on and the list below shows only what you need.
      </p>
      <div role="group" aria-label="Stacks" className="mt-3 flex flex-wrap gap-2">
        {stacks.map((stack) => {
          const Icon = STACK_ICONS[stack.id];
          if (stack.alwaysOn) {
            return (
              <SimpleTooltip key={stack.id} label="Always on. Everything else builds on it.">
                <span className="flex h-7 shrink-0 cursor-default items-center gap-1.5 whitespace-nowrap rounded-full bg-primary/12 px-3 text-xs font-medium text-primary ring-1 ring-inset ring-primary/30 [&_svg]:size-3.5 [&_svg]:shrink-0">
                  <Icon />
                  {stack.name}
                  <Lock aria-hidden className="opacity-70" />
                </span>
              </SimpleTooltip>
            );
          }
          return (
            // FilterChip does not pass the tooltip's trigger props down to its button, so the
            // tooltip hangs off a span around it instead.
            <SimpleTooltip key={stack.id} label={stack.description} wrapTrigger>
              <FilterChip
                active={selected.includes(stack.id)}
                onClick={() => onToggle(stack.id)}
                icon={<Icon />}
              >
                {stack.name}
              </FilterChip>
            </SimpleTooltip>
          );
        })}
      </div>
    </section>
  );
}
