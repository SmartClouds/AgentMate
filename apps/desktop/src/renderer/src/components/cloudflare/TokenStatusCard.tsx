import { missingPermissionLabels, TOKEN_PAGE } from '@shared/cloudflare/permissions';
import type { CloudflareAccountStatus } from '@shared/cloudflareTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ExternalLink, Key, RefreshCw, Trash2 } from '@/components/icons';
import { Chip, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { CloudflareMark } from './CloudflareMark';
import { CloudflareCard, Notice } from './fields';
import { PermissionList } from './PermissionList';

/**
 * One account's saved token: whether Cloudflare still takes it, what it may do, and when
 * something is missing, the exact permissions to add on Cloudflare (AC1) with a way to check again
 * after. Editing a token's permissions keeps its value, so nothing needs pasting again.
 *
 * It sits above the zone being managed, so it is one line (the state and when it was checked)
 * until asked for more. A token that needs attention, or one that was never checked, opens by
 * itself, so a problem is never folded away.
 */
export function TokenStatusCard({
  account,
  showName,
  defaultOpen = false,
  onReplace,
}: {
  account: CloudflareAccountStatus;
  /** Put the account's name in the title, for when more than one is connected. */
  showName: boolean;
  /** Start with the details open. A token with a problem starts open either way. */
  defaultOpen?: boolean;
  onReplace: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const bodyId = useId();
  const [checking, setChecking] = useState(false);
  const report = account.report;
  const missing = (report?.permissions ?? [])
    .filter((check) => check.state === 'missing')
    .map((check) => check.id);
  const labels = missingPermissionLabels(missing);
  const zoneCount = report?.zoneCount ?? 0;
  const showFix = report !== null && (labels.length > 0 || zoneCount === 0);
  const needsAttention = report === null || report.status !== 'active' || showFix;
  const [open, setOpen] = useState(defaultOpen || needsAttention);

  async function checkAgain(): Promise<void> {
    setChecking(true);
    try {
      const next = await window.runova.cloudflare.checkToken(account.id);
      queryClient.setQueryData(queryKeys.cloudflareStatus, next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.cloudflareData });
      toast.success('Checked the token again.');
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    } finally {
      setChecking(false);
    }
  }

  async function remove(): Promise<void> {
    const confirmed = await confirmDialog({
      title: showName ? `Remove ${account.label}?` : 'Remove the Cloudflare token?',
      description: `Runova forgets the token and stops managing ${showName ? 'the domains of this account' : 'your domains'}. The token keeps working on Cloudflare until you delete it there.`,
      confirmLabel: 'Remove the token',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      const next = await window.runova.cloudflare.removeToken(account.id);
      queryClient.setQueryData(queryKeys.cloudflareStatus, next);
      queryClient.removeQueries({ queryKey: queryKeys.cloudflareData });
      toast.success(showName ? `Removed ${account.label}.` : 'Removed the Cloudflare token.');
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    }
  }

  let badge: React.ReactNode;
  if (report && report.status !== 'active') {
    badge = (
      <Chip tone="warning" dot>
        {report.status === 'expired' ? 'Expired' : 'Disabled'}
      </Chip>
    );
  } else if (labels.length > 0) {
    badge = (
      <Chip tone="warning" dot>
        Missing permissions
      </Chip>
    );
  } else {
    badge = (
      <Chip tone="success" dot>
        Active
      </Chip>
    );
  }

  const checkButton = (
    <Button size="sm" variant="soft" disabled={checking} onClick={() => void checkAgain()}>
      <RefreshCw className={cn('h-3.5 w-3.5', checking && 'motion-safe:animate-spin')} /> Check
      again
    </Button>
  );

  return (
    <CloudflareCard
      icon={<CloudflareMark />}
      title={showName ? account.label : 'Cloudflare token'}
      extra={badge}
      description={
        report
          ? `Checked ${timeAgo(new Date(report.checkedAt).toISOString())}. It can see ${zoneCount} ${zoneCount === 1 ? 'domain' : 'domains'}.`
          : 'Saved, but not checked yet.'
      }
      actions={
        <Button
          size="sm"
          variant="soft"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          Details
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 transition-transform motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </Button>
      }
    >
      {open && (
        <div id={bodyId} className={cn(FOOTER_HAIRLINE, 'space-y-3 px-4 py-3')}>
          {showFix && (
            <section aria-label="What to add to the token">
              <Notice tone="warning">
                <div className="space-y-2.5">
                  <p>
                    {labels.length > 0
                      ? 'On Cloudflare, open My Profile > API Tokens, edit this token and add these permissions, then check again:'
                      : 'On Cloudflare, open My Profile > API Tokens and edit this token.'}
                  </p>
                  {labels.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {labels.map((label) => (
                        <li
                          key={label}
                          className="rounded-md bg-background/60 px-2 py-0.5 font-mono text-xs text-foreground ring-1 ring-inset ring-foreground/[0.08]"
                        >
                          {label}
                        </li>
                      ))}
                    </ul>
                  )}
                  {zoneCount === 0 && (
                    <p className="text-muted-foreground">
                      The token cannot see any domains. Under Zone Resources, include the domains
                      Runova should manage.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => void window.runova.shell.openExternal(TOKEN_PAGE)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" /> Edit the token on Cloudflare
                    </Button>
                    {checkButton}
                  </div>
                </div>
              </Notice>
            </section>
          )}
          {report && (
            <p className="text-xs text-muted-foreground">
              {report.source === 'policies'
                ? "Read from the token's own permissions."
                : 'Checked by reading, which changes nothing, so edit access is confirmed the first time you make a change.'}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {!showFix && checkButton}
            <Button size="sm" variant="soft" onClick={onReplace}>
              <Key className="h-3.5 w-3.5" /> Replace token
            </Button>
            <Button size="sm" variant="danger" onClick={() => void remove()}>
              <Trash2 className="h-3.5 w-3.5" /> Remove token
            </Button>
          </div>
          {report && <PermissionList checks={report.permissions} />}
        </div>
      )}
    </CloudflareCard>
  );
}
