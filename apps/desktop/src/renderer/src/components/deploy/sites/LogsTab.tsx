import type { SiteLogKind } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { CircleCheck, RefreshCw, Spinner, TriangleAlert } from '@/components/icons';
import { PillTabs, SECTION_WELL } from '@/components/pageKit';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { useSiteLog } from './hooks';

/**
 * A site's access and error logs as nginx writes them. The text is what visitors sent, so it is
 * shown as plain text only. When nginx rotates the file the view starts over and says so.
 */

function LogView({
  serverId,
  siteId,
  kind,
}: {
  serverId: string;
  siteId: string;
  kind: SiteLogKind;
}): React.JSX.Element {
  const log = useSiteLog(serverId, siteId, kind);
  const bottom = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const followId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: each new line scrolls to the bottom
  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [log.lines.length, follow]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span role="status" className="flex items-center gap-1.5">
          {log.ended ? (
            <>
              <TriangleAlert className="h-3 w-3 text-warning" /> Stopped
            </>
          ) : (
            <>
              <CircleCheck className="h-3 w-3 text-success" /> Following live
            </>
          )}
        </span>
        {log.resets > 0 && (
          <span className="flex items-center gap-1.5">
            <RefreshCw className="h-3 w-3" />
            {log.resets === 1
              ? 'The log was rotated once'
              : `The log was rotated ${log.resets} times`}
            , so older lines are gone from this view.
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Checkbox
            id={followId}
            checked={follow}
            onCheckedChange={(checked) => setFollow(checked === true)}
          />
          <label htmlFor={followId} className="cursor-pointer">
            Keep scrolled to the newest line
          </label>
        </span>
      </div>
      <div
        role="log"
        aria-label={kind === 'access' ? 'Access log' : 'Error log'}
        aria-live="off"
        className={cn(SECTION_WELL, 'h-80 overflow-auto font-mono text-xs leading-relaxed')}
      >
        {log.lines.length === 0 ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            {log.ended ? (
              'Nothing to show.'
            ) : (
              <>
                <Spinner className="h-3 w-3 motion-safe:animate-spin" /> Waiting for requests…
              </>
            )}
          </p>
        ) : (
          log.lines.map((line, index) => (
            <div
              key={index}
              className={cn(
                'whitespace-pre-wrap break-all',
                kind === 'error' && /\[(error|crit|alert|emerg)\]/.test(line) && 'text-destructive',
                kind === 'error' && /\[warn\]/.test(line) && 'text-warning',
              )}
            >
              {line}
            </div>
          ))
        )}
        <div ref={bottom} />
      </div>
      {log.error && (
        <p role="alert" className="text-sm text-destructive">
          {log.error}
        </p>
      )}
    </div>
  );
}

export function LogsTab({
  serverId,
  siteId,
}: {
  serverId: string;
  siteId: string;
}): React.JSX.Element {
  const [kind, setKind] = useState<SiteLogKind>('access');
  return (
    <div className="space-y-2">
      <PillTabs<SiteLogKind>
        id="site-log-kind"
        kind="toggle"
        label="Which log"
        size="xs"
        className="w-fit"
        items={[
          { value: 'access', label: 'Access log' },
          { value: 'error', label: 'Error log' },
        ]}
        value={kind}
        onChange={setKind}
      />
      <LogView key={kind} serverId={serverId} siteId={siteId} kind={kind} />
    </div>
  );
}
