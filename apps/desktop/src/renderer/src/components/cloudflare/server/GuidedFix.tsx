import { cloudflarePermission, TOKEN_PAGE } from '@shared/cloudflare/permissions';
import {
  cloudflareErrorCode,
  cloudflareErrorMessage,
  cloudflareErrorPermission,
} from '@shared/cloudflareErrors';
import { coreErrorMessage } from '@shared/coreErrors';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Key, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/queryKeys';
import { Notice } from '../fields';

/**
 * What went wrong with a Cloudflare step, and when Cloudflare refused it for want of a
 * permission, exactly what to add to the token and where (AC1): the permission as the token page
 * names it, a button to that page, and, when there is one, another way (`alternative`).
 */
export function GuidedFix({
  error,
  alternative,
}: {
  error: unknown;
  /** Shown under the fix, such as "or paste a token you made yourself". */
  alternative?: React.ReactNode;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  if (!error) return null;
  const permission =
    cloudflareErrorCode(error) === 'missing-permission' ? cloudflareErrorPermission(error) : null;
  if (!permission) {
    const words = cloudflareErrorCode(error)
      ? cloudflareErrorMessage(error)
      : coreErrorMessage(error);
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{words}</span>
      </p>
    );
  }
  const needed = cloudflarePermission(permission);
  return (
    <Notice role="alert" tone="warning" icon={Key}>
      <div className="space-y-2">
        <p>
          The Cloudflare token cannot {needed.action} yet. On Cloudflare, edit the token and add{' '}
          <span className="font-mono text-xs">{needed.label}</span>, then try again.
        </p>
        <Button
          type="button"
          size="sm"
          variant="soft"
          onClick={() => {
            void window.runova.shell.openExternal(TOKEN_PAGE);
            void queryClient.invalidateQueries({ queryKey: queryKeys.cloudflareStatus });
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open Cloudflare's token page
        </Button>
        {alternative}
      </div>
    </Notice>
  );
}
