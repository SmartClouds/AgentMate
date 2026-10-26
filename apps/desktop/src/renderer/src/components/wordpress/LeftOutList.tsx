import { wpItemKey } from '@runova/core';
import type {
  DeployWordPressLeftOut,
  DeployWordPressLeftOutReason,
} from '@shared/deployWordPressTypes';
import { useState } from 'react';
import { Lock } from '@/components/icons';
import { isAgentPath, LEFT_OUT_REASON } from '@/components/projects/wordpress/wordpressCopy';
import { Button } from '@/components/ui/button';
import type { SyncDirection } from './ChangeList';

/**
 * What a pull or deploy leaves out, and why (E21). Agent settings and Runova's own files get
 * their own heading that is always open: the promise that they never leave this computer is
 * something the user should be able to check on every deploy, not dig for.
 */

/** How many paths of one reason show before the rest wait behind a button. */
const OTHER_LIMIT = 50;

const REASON_ORDER: readonly DeployWordPressLeftOutReason[] = [
  'hardDenied',
  'pathRejected',
  'symlink',
  'tooLarge',
  'caseCollision',
  'notUtf8',
  'ignored',
];

/**
 * Agent files under the agent heading, whatever reason the walker gave: an agent folder caught by
 * the general deny list is still an agent folder.
 */
export function isAgentLeftOut(entry: DeployWordPressLeftOut): boolean {
  if (entry.reason === 'agentFiles') return true;
  return (
    (entry.reason === 'hardDenied' || entry.reason === 'pathRejected') && isAgentPath(entry.path)
  );
}

export const AGENT_HEADING = 'Stays on this computer: agent settings and Runova files';

export function LeftOutList({
  entries,
  direction,
}: {
  entries: readonly DeployWordPressLeftOut[];
  direction: SyncDirection;
}): React.JSX.Element {
  const agent = entries.filter(isAgentLeftOut);
  const others = entries.filter((entry) => !isAgentLeftOut(entry));
  const byReason = REASON_ORDER.map((reason) => ({
    reason,
    entries: others.filter((entry) => entry.reason === reason),
  })).filter((group) => group.entries.length > 0);

  return (
    <section aria-label="Left out" className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg bg-success/[0.07] px-3 py-2 text-sm ring-1 ring-inset ring-success/20">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
        <p className="text-foreground/90">
          Agent settings, skills and Runova's own files in this project never leave this computer.
          Only the theme and plugin files listed for this{' '}
          {direction === 'deploy' ? 'deploy' : 'pull'} travel.
        </p>
      </div>

      {agent.length > 0 ? (
        <div className="space-y-1">
          <h4 className="px-1 text-xs font-medium text-foreground">
            {AGENT_HEADING}{' '}
            <span className="font-normal tabular-nums text-muted-foreground">({agent.length})</span>
          </h4>
          <ul aria-label={AGENT_HEADING} className="space-y-0.5 px-1">
            {agent.map((entry) => (
              <li
                key={`${wpItemKey(entry.item)}/${entry.path}`}
                className="flex min-w-0 items-baseline gap-2 text-xs"
              >
                <span className="shrink-0 text-muted-foreground">{entry.item.slug}</span>
                <span className="min-w-0 truncate font-mono">{entry.path}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {byReason.map((group) => (
        <ReasonGroup key={group.reason} reason={group.reason} entries={group.entries} />
      ))}

      {entries.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">Nothing else is left out.</p>
      ) : null}
    </section>
  );
}

function ReasonGroup({
  reason,
  entries,
}: {
  reason: DeployWordPressLeftOutReason;
  entries: DeployWordPressLeftOut[];
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? entries : entries.slice(0, OTHER_LIMIT);
  const label = LEFT_OUT_REASON[reason];
  return (
    <div className="space-y-1">
      <h4 className="px-1 text-xs font-medium text-foreground">
        {label}{' '}
        <span className="font-normal tabular-nums text-muted-foreground">({entries.length})</span>
      </h4>
      <ul aria-label={label} className="space-y-0.5 px-1">
        {shown.map((entry) => (
          <li
            key={`${wpItemKey(entry.item)}/${entry.path}`}
            className="flex min-w-0 items-baseline gap-2 text-xs"
          >
            <span className="shrink-0 text-muted-foreground">{entry.item.slug}</span>
            <span className="min-w-0 truncate font-mono">{entry.path}</span>
          </li>
        ))}
      </ul>
      {entries.length > shown.length ? (
        <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
          Show {entries.length - shown.length} more
        </Button>
      ) : null}
    </div>
  );
}
