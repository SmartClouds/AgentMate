import type { UsageTokens } from '@runova/core';
import { formatTokens } from '@/lib/usageFormat';
import { cn } from '@/lib/utils';

/** The four kinds of token, in the fixed order that gives each its chart color. */
export const TOKEN_KINDS = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheWrite', label: 'Cache write' },
] as const satisfies readonly { key: keyof UsageTokens; label: string }[];

/** A share of the total as a whole percent, keeping a sliver visible as "<1%". */
export function share(part: number, total: number): string {
  if (total <= 0 || part <= 0) return '0%';
  const percent = (part / total) * 100;
  return percent < 1 ? '<1%' : `${Math.round(percent)}%`;
}

/**
 * One thin stacked bar of where the tokens went. The legend under it carries the numbers. The
 * caller sets the margins, since the menu and the project page space it differently.
 */
export function TokenShareBar({
  tokens,
  colors,
  className,
}: {
  tokens: UsageTokens;
  colors: string[];
  className?: string;
}): React.JSX.Element {
  const parts = TOKEN_KINDS.flatMap((kind, i) =>
    tokens[kind.key] > 0 ? [{ ...kind, value: tokens[kind.key], color: colors[i] }] : [],
  );
  const summary = TOKEN_KINDS.map((k) => `${k.label} ${share(tokens[k.key], tokens.total)}`).join(
    ', ',
  );
  return (
    <div
      role="img"
      aria-label={`Token split: ${summary}`}
      className={cn('flex h-2 gap-[2px]', className)}
    >
      {parts.map((part, i) => (
        <span
          key={part.key}
          // Grown by value, with a floor so a sliver is still a visible mark.
          style={{ flex: `${part.value} 1 0`, backgroundColor: part.color }}
          className={cn(
            'h-full min-w-[3px] rounded-[2px]',
            i === 0 && 'rounded-l-full',
            i === parts.length - 1 && 'rounded-r-full',
          )}
        />
      ))}
    </div>
  );
}

export function TokenLegend({
  tokens,
  colors,
  className,
}: {
  tokens: UsageTokens;
  colors: string[];
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('text-[12px]', className)}>
      {TOKEN_KINDS.map((kind, i) => (
        <div
          key={kind.key}
          className="grid grid-cols-[auto_1fr_auto_2.25rem] items-center gap-x-2 py-[3px]"
        >
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: colors[i] }}
          />
          <span className="text-muted-foreground">{kind.label}</span>
          <span className="tabular-nums">{formatTokens(tokens[kind.key])}</span>
          <span className="text-right text-[11px] tabular-nums text-muted-foreground">
            {share(tokens[kind.key], tokens.total)}
          </span>
        </div>
      ))}
    </div>
  );
}
