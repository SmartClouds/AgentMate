import type { AndroidSdkStatus } from '@runova/core';
import {
  Android,
  CircleCheck,
  CircleX,
  ExternalLink,
  FolderOpen,
  RefreshCw,
} from '@/components/icons';
import { EmptyState, GLASS_CARD, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * What the page shows when it cannot talk to an SDK. The list of probed paths is the point: a
 * bare "not found" leaves the user guessing, while seeing that ANDROID_HOME was never checked
 * because it is unset, or that the folder they picked has no platform-tools, is a fix they can
 * make themselves.
 */

const INSTALL_URL = 'https://developer.android.com/studio';

interface SdkSetupPanelProps {
  sdk: AndroidSdkStatus;
  busy: boolean;
  onChooseFolder: () => void;
  onClearOverride: () => void;
  onRecheck: () => void;
}

function CheckedPaths({ sdk }: { sdk: AndroidSdkStatus }): React.JSX.Element {
  return (
    <section aria-label="Where Runova looked" className={cn(GLASS_CARD, 'overflow-hidden')}>
      <div className="flex h-10 items-center pl-3.5 pr-2 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
        <p className={SECTION_HEADING}>Where Runova looked</p>
      </div>
      <ul className="settings-rows">
        {sdk.checked.map((path) => {
          const found = path === sdk.root && sdk.status === 'found';
          return (
            <li key={path} className="flex items-start gap-2.5 px-3.5 py-2 text-xs">
              {found ? (
                <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              ) : (
                <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
              )}
              <span className="break-all font-mono text-muted-foreground">{path}</span>
            </li>
          );
        })}
      </ul>
      <p className="px-3.5 pb-3 pt-2 text-xs leading-relaxed text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
        An SDK folder holds at least one of platform-tools, emulator or cmdline-tools. Android
        Studio installs one for you, or you can install the command-line tools on their own.
      </p>
    </section>
  );
}

export function SdkSetupPanel({
  sdk,
  busy,
  onChooseFolder,
  onClearOverride,
  onRecheck,
}: SdkSetupPanelProps): React.JSX.Element {
  const overrideInvalid = sdk.status === 'override-invalid';

  return (
    <div className="flex flex-col gap-2">
      <div className={GLASS_CARD}>
        <EmptyState
          size="lg"
          icon={Android}
          title={overrideInvalid ? "That folder isn't an Android SDK" : 'Android SDK not found'}
          description={
            overrideInvalid
              ? 'The Android SDK path in Settings points somewhere that has no SDK in it. Pick the right folder, or clear the override and let Runova find one.'
              : 'Runova checked ANDROID_HOME, ANDROID_SDK_ROOT and the usual install folders for this system and came up empty. Point it at your SDK, or install one.'
          }
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button disabled={busy} onClick={onChooseFolder}>
                <FolderOpen className="h-3.5 w-3.5" />
                Choose SDK folder
              </Button>
              {overrideInvalid && (
                <Button variant="soft" disabled={busy} onClick={onClearOverride}>
                  Clear override
                </Button>
              )}
              <Button variant="soft" disabled={busy} onClick={onRecheck}>
                <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
                Check again
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                onClick={() => void window.runova.shell.openExternal(INSTALL_URL)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                How to install
              </Button>
            </div>
          }
        />
      </div>
      <CheckedPaths sdk={sdk} />
    </div>
  );
}
