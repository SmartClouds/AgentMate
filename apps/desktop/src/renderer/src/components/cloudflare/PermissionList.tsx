import { CLOUDFLARE_PERMISSIONS } from '@shared/cloudflare/permissions';
import type { CloudflarePermissionCheck, CloudflarePermissionState } from '@shared/cloudflareTypes';
import { CircleCheck, CircleQuestion, CircleX } from '@/components/icons';
import { Chip, type ChipTone, SECTION_WELL } from '@/components/pageKit';
import { cn } from '@/lib/utils';

const STATE_TEXT: Record<CloudflarePermissionState, string> = {
  granted: 'Granted',
  missing: 'Missing',
  unverified: 'Checked when first used',
};

const STATE_TONE: Record<CloudflarePermissionState, ChipTone> = {
  granted: 'success',
  missing: 'destructive',
  unverified: 'neutral',
};

function StateChip({ state }: { state: CloudflarePermissionState }): React.JSX.Element {
  const Icon = state === 'granted' ? CircleCheck : state === 'missing' ? CircleX : CircleQuestion;
  return (
    <Chip tone={STATE_TONE[state]}>
      <Icon />
      {STATE_TEXT[state]}
    </Chip>
  );
}

/**
 * The permissions Runova asks for, as the token page names them, with what each one is for.
 * Given a check, each row also says (in words, with an icon) whether the token has it.
 */
export function PermissionList({
  checks,
}: {
  checks?: CloudflarePermissionCheck[];
}): React.JSX.Element {
  const stateOf = new Map(checks?.map((check) => [check.id, check.state]));
  return (
    // The well keeps its own padding off, so the hairlines run edge to edge like a Settings card.
    <ul className={cn(SECTION_WELL, 'settings-rows p-0')}>
      {CLOUDFLARE_PERMISSIONS.map((permission) => {
        const state = stateOf.get(permission.id);
        return (
          <li key={permission.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-xs text-foreground">{permission.label}</p>
              <p className="text-xs text-muted-foreground">{permission.purpose}</p>
            </div>
            {state && <StateChip state={state} />}
          </li>
        );
      })}
    </ul>
  );
}
