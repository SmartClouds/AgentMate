import type { FileSiteInput } from '@shared/deployFilesTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ArrowUp, ChevronRight, Folder, FolderOpen } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { filesProblem } from './messages';

/**
 * Picks the folder on the server for an FTP or SFTP site (E23). It opens where the field points,
 * or where the login starts when the field is empty, and walks folders the way a file dialog
 * does. A popover rather than a dialog, so the form under it stays readable.
 *
 * The site details it browses with may carry a typed password. They stay in the call; the cache
 * key names the connection without it (`target`), and nothing is kept once the popover closes.
 */

export interface RemoteFolderBrowserProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string | null;
  site: FileSiteInput;
  /** Names the connection, without its secret, so a corrected host or login loads afresh. */
  target: string;
  /** Where to start; null for the folder the login starts in. */
  initialPath: string | null;
  onPick: (path: string) => void;
  /** The button that opens it. */
  children: React.ReactElement;
}

interface Crumb {
  name: string;
  path: string;
}

function crumbsOf(path: string): Crumb[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join('/')}` }));
}

const SKELETON_WIDTHS = [62, 44, 70, 38, 54];

export function RemoteFolderBrowser({
  open,
  onOpenChange,
  siteId,
  site,
  target,
  initialPath,
  onPick,
  children,
}: RemoteFolderBrowserProps): React.JSX.Element {
  const [path, setPath] = useState<string | null>(initialPath);

  // Every opening starts at the field's folder, never where the last visit ended.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when it opens
  useEffect(() => {
    if (open) setPath(initialPath);
  }, [open]);

  const folder = useQuery({
    queryKey: queryKeys.deployFilesBrowse(target, path),
    queryFn: () => window.runova.deployFiles.browseRemote({ siteId, site, path }),
    enabled: open,
    retry: false,
    gcTime: 0,
    staleTime: 15_000,
    meta: { silentLoading: true },
  });

  const shown = folder.data ?? null;
  const shownPath = shown?.path ?? path;
  const loading = folder.isFetching && !folder.isError;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2 p-2"
        aria-label="Choose a folder on the server"
      >
        <div className="flex items-center gap-1.5">
          <SimpleTooltip label="Up one level">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Up one level"
              disabled={!shown?.parent || loading}
              onClick={() => shown?.parent && setPath(shown.parent)}
            >
              <ArrowUp />
            </Button>
          </SimpleTooltip>
          <nav
            aria-label="Folder path"
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs [scrollbar-width:none]"
          >
            {shownPath === null ? (
              <Skeleton className="h-4 w-28 rounded-full" />
            ) : (
              <>
                <CrumbButton
                  label="/"
                  ariaLabel="Top folder"
                  current={shownPath === '/'}
                  onClick={() => setPath('/')}
                />
                {crumbsOf(shownPath).map((crumb, index, all) => (
                  <span key={crumb.path} className="flex items-center gap-0.5">
                    {index > 0 && <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/60" />}
                    <CrumbButton
                      label={crumb.name}
                      current={index === all.length - 1}
                      onClick={() => setPath(crumb.path)}
                    />
                  </span>
                ))}
              </>
            )}
          </nav>
        </div>

        {folder.isError ? (
          <Notice
            role="alert"
            tone="destructive"
            size="sm"
            action={
              <>
                <Button
                  type="button"
                  size="xs"
                  variant="soft"
                  onClick={() => void folder.refetch()}
                >
                  Try again
                </Button>
                {path !== null && (
                  <Button type="button" size="xs" variant="ghost" onClick={() => setPath(null)}>
                    Go to the start folder
                  </Button>
                )}
              </>
            }
          >
            {filesProblem(folder.error)}
          </Notice>
        ) : (
          <ul
            aria-label="Folders"
            aria-busy={loading || undefined}
            className="rail-scroll max-h-64 min-h-[8rem] space-y-0.5 overflow-y-auto"
          >
            {loading || !shown ? (
              SKELETON_WIDTHS.map((width) => (
                <li key={width} className="flex h-8 items-center gap-2.5 px-2.5">
                  <Skeleton className="h-3.5 w-3.5 shrink-0 rounded" />
                  <Skeleton className="h-3 rounded-full" style={{ width: `${width}%` }} />
                </li>
              ))
            ) : shown.folders.length === 0 ? (
              <li className="flex h-24 items-center justify-center text-xs text-muted-foreground">
                No folders in here.
              </li>
            ) : (
              shown.folders.map((one) => (
                <li key={one.path}>
                  <button
                    type="button"
                    onClick={() => setPath(one.path)}
                    className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.07] focus-visible:outline-none"
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0 text-primary/80" />
                    <span className="truncate">{one.name}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}

        <div className="flex items-center gap-2 border-t border-border/50 pt-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {shownPath ?? ' '}
          </code>
          <Button
            type="button"
            size="sm"
            disabled={!shown || loading || folder.isError}
            onClick={() => {
              if (!shown) return;
              onPick(shown.path);
              onOpenChange(false);
            }}
          >
            <FolderOpen />
            Use this folder
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CrumbButton({
  label,
  ariaLabel,
  current,
  onClick,
}: {
  label: string;
  ariaLabel?: string;
  current: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'shrink-0 cursor-pointer whitespace-nowrap rounded-md px-1.5 py-0.5 font-mono transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        current ? 'font-semibold text-foreground' : 'text-muted-foreground',
      )}
    >
      {label}
    </button>
  );
}
