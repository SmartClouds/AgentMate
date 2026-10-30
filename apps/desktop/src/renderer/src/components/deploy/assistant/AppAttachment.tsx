import type { DeployAssistantAppRef } from '@shared/deployAssistantTypes';
import { Package, Plus, X } from '@/components/icons';
import { SimpleTooltip } from '@/components/ui/tooltip';

/**
 * The app a chat is about, above the task box. On an app's page it is there by default, so a
 * question is about that app without saying so; the AI is given its services, containers and
 * their logs, and can run commands in them like any other (with the user's approval). The user
 * can take it off, and put it back while they are still on its page. It cannot change while a
 * run goes, since the run read the app when it started.
 */
export function AppAttachment({
  app,
  suggested,
  locked,
  onRemove,
  onAttach,
}: {
  /** The app the next run is about, or null. */
  app: DeployAssistantAppRef | null;
  /** The app whose page is open, when the user took it off. */
  suggested: DeployAssistantAppRef | null;
  locked: boolean;
  onRemove: () => void;
  onAttach: () => void;
}): React.JSX.Element | null {
  if (!app && !suggested) return null;
  return (
    <div
      role="group"
      aria-label="Attached"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
    >
      {app ? (
        <>
          <SimpleTooltip label={`App: ${app.name}`}>
            <span className="inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-primary/12 pl-2 pr-1 text-xs font-medium text-primary">
              <Package className="h-3 w-3 shrink-0" />
              <span className="truncate">{app.name}</span>
              {!locked && (
                <button
                  type="button"
                  aria-label={`Remove ${app.name} from this chat`}
                  onClick={onRemove}
                  className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </span>
          </SimpleTooltip>
          <span className="min-w-0 text-[11px] text-muted-foreground">
            The AI reads its containers and logs
          </span>
        </>
      ) : (
        suggested &&
        !locked && (
          <button
            type="button"
            onClick={onAttach}
            aria-label={`Attach ${suggested.name}`}
            className="inline-flex h-6 min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground ring-1 ring-inset ring-foreground/[0.12] transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="h-3 w-3 shrink-0" />
            <span className="truncate">Attach {suggested.name}</span>
          </button>
        )
      )}
    </div>
  );
}
