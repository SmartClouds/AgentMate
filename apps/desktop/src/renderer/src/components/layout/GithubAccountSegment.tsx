import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { GithubAccount } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink, Github, RefreshCw, TriangleAlert, UserPlus } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useTerminalStore } from '@/stores/terminalStore';
import { focusPanel, PanelTitle, PopSegment } from './statusBarKit';

/**
 * Who the GitHub CLI is signed in as, in the status bar. Pull requests, workflow runs and new
 * repositories all go out under that account, so it should never be a guess which one it is.
 *
 * Hidden until the first answer arrives and whenever `gh` is not installed, the way Docker's entry
 * is. Signed out is a quiet "Not signed in" rather than a warning, since plenty of people never
 * use GitHub from here. A read that failed for another reason (a dropped connection) keeps the
 * last account it knew, dimmed and flagged, instead of telling a signed-in person to sign in.
 */

/**
 * Signed in changes rarely, so it is rechecked rarely. Signed out is rechecked quickly because it
 * is the state someone is about to leave: a signed-out `gh` fails on the machine without reaching
 * GitHub, so the extra checks are cheap, and a login finished in a browser then shows up within
 * seconds. A check that failed on the network is retried more slowly, since each try can stall.
 */
const SIGNED_IN_REFRESH_MS = 5 * 60_000;
const SIGNED_OUT_REFRESH_MS = 15_000;
const FAILED_REFRESH_MS = 60_000;
/** Short, so coming back to the window from a browser sign-in does check again. */
const STALE_MS = 10_000;
const MAX_ORGS_SHOWN = 8;

const SIGN_IN_COMMAND = 'gh auth login';

type View =
  | { kind: 'hidden' }
  | { kind: 'signed-in'; account: GithubAccount; problem: string | null }
  | { kind: 'signed-out' }
  | { kind: 'unknown'; problem: string };

function profileUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}`;
}

/** gh's stderr can run to several lines; it is folded into one, and the panel clamps its height. */
function cleanProblem(message: string | undefined): string {
  return message?.replace(/\s+/g, ' ').trim() || 'The GitHub CLI did not answer.';
}

function useGithubAccountView(): {
  view: View;
  refresh: () => void;
  refreshing: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.githubAccount,
    queryFn: () => window.runova.git.githubAccount(),
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => {
      const last = q.state.data;
      if (last?.authenticated) return SIGNED_IN_REFRESH_MS;
      return last?.checkFailed ? FAILED_REFRESH_MS : SIGNED_OUT_REFRESH_MS;
    },
    meta: { silentLoading: true },
  });
  const data = query.data;

  // The last account that was read, so one failed refresh does not blank the bar. A read that
  // plainly says nobody is signed in forgets it, or a later network blip would bring it back.
  const [known, setKnown] = useState<GithubAccount | null>(null);
  useEffect(() => {
    if (!data) return;
    if (data.authenticated && data.login) setKnown(data);
    else if (!data.checkFailed) setKnown(null);
  }, [data]);

  let view: View;
  if (data?.authenticated && data.login) {
    view = { kind: 'signed-in', account: data, problem: null };
  } else if (data?.checkFailed || (query.isError && !data)) {
    const problem = cleanProblem(data?.error ?? (query.error as Error | null)?.message);
    view = known ? { kind: 'signed-in', account: known, problem } : { kind: 'unknown', problem };
  } else if (data && data.cliAvailable) {
    view = { kind: 'signed-out' };
  } else {
    view = { kind: 'hidden' };
  }

  return { view, refresh: () => void query.refetch(), refreshing: query.isFetching };
}

function Monogram({ login }: { login: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold uppercase text-primary"
    >
      {login.slice(0, 1)}
    </span>
  );
}

function Problem({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mb-2 flex items-start gap-1.5 text-[10px] text-muted-foreground">
      <TriangleAlert className="mt-px h-3 w-3 shrink-0 text-warning" />
      <span className="line-clamp-3 break-words">{children}</span>
    </p>
  );
}

function SignInButton({ label }: { label: string }): React.JSX.Element {
  const openSession = useTerminalStore((s) => s.openSession);
  return (
    <PopoverPrimitive.Close asChild>
      <Button
        variant="soft"
        size="xs"
        onClick={() => {
          openSession({ title: 'GitHub login', initialInput: SIGN_IN_COMMAND });
          toast.info('Press Enter in the terminal to sign in to GitHub.');
        }}
      >
        <UserPlus />
        {label}
      </Button>
    </PopoverPrimitive.Close>
  );
}

function SignedInPanel({
  account,
  problem,
}: {
  account: GithubAccount;
  problem: string | null;
}): React.JSX.Element {
  const login = account.login ?? '';
  const orgs = account.owners.filter((owner) => owner.type === 'organization');
  return (
    <>
      {problem ? (
        <Problem>{`Couldn't refresh, so this may be out of date: ${problem}`}</Problem>
      ) : null}
      <div className="flex items-center gap-2.5">
        <Monogram login={login} />
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold">{account.name || login}</p>
          {account.name ? (
            <p className="truncate text-[11px] text-muted-foreground">@{login}</p>
          ) : null}
        </div>
      </div>
      {orgs.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1 text-[10px] font-medium text-muted-foreground">Organizations</p>
          <div className="flex flex-wrap gap-1">
            {orgs.slice(0, MAX_ORGS_SHOWN).map((org) => (
              <span
                key={org.login}
                className="max-w-full truncate rounded-md bg-foreground/[0.05] px-1.5 py-0.5 text-[11px]"
              >
                {org.login}
              </span>
            ))}
            {orgs.length > MAX_ORGS_SHOWN ? (
              <span className="px-1 py-0.5 text-[11px] text-muted-foreground">
                and {orgs.length - MAX_ORGS_SHOWN} more
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-2">
        <PopoverPrimitive.Close asChild>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void window.runova.shell.openExternal(profileUrl(login))}
          >
            <ExternalLink />
            Open profile
          </Button>
        </PopoverPrimitive.Close>
        <SignInButton label="Use another account" />
      </div>
    </>
  );
}

export function GithubAccountSegment(): React.JSX.Element | null {
  const { view, refresh, refreshing } = useGithubAccountView();
  if (view.kind === 'hidden') return null;

  const refreshLabel = 'Check the GitHub sign-in again';
  const refreshButton = (
    <SimpleTooltip label={refreshLabel} side="top">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={refreshLabel}
        // aria-disabled rather than disabled, so focus stays on the button while it works.
        aria-disabled={refreshing}
        aria-busy={refreshing}
        onClick={() => {
          if (!refreshing) refresh();
        }}
        className="shrink-0"
      >
        <RefreshCw className={cn(refreshing && 'motion-safe:animate-spin')} />
      </Button>
    </SimpleTooltip>
  );

  if (view.kind === 'signed-in') {
    const { account, problem } = view;
    const login = account.login ?? '';
    return (
      <PopSegment
        label={`GitHub: signed in as ${login}${problem ? ', could not refresh' : ''}`}
        width="w-72"
        onOpenAutoFocus={focusPanel}
        className={cn(problem && 'opacity-60')}
        panel={
          <>
            <PanelTitle title="GitHub account" detail="GitHub CLI" action={refreshButton} />
            <SignedInPanel account={account} problem={problem} />
          </>
        }
      >
        <Github className="h-2.5 w-2.5" />
        <span className="max-w-[9rem] truncate">@{login}</span>
        {problem ? <TriangleAlert className="h-3 w-3 shrink-0" /> : null}
      </PopSegment>
    );
  }

  if (view.kind === 'signed-out') {
    return (
      <PopSegment
        label="GitHub: not signed in"
        width="w-72"
        onOpenAutoFocus={focusPanel}
        panel={
          <>
            <PanelTitle title="GitHub account" detail="GitHub CLI" action={refreshButton} />
            <p className="text-[11px] text-muted-foreground">
              The GitHub CLI is not signed in. Pull requests, workflow runs and creating
              repositories need it.
            </p>
            <div className="mt-3 flex items-center gap-1.5">
              <SignInButton label="Sign in with gh" />
            </div>
          </>
        }
      >
        <Github className="h-2.5 w-2.5" />
        <span>Not signed in</span>
      </PopSegment>
    );
  }

  return (
    <PopSegment
      label="GitHub: could not check the sign-in"
      width="w-72"
      onOpenAutoFocus={focusPanel}
      className="text-warning hover:text-warning"
      panel={
        <>
          <PanelTitle title="GitHub account" detail="GitHub CLI" action={refreshButton} />
          <Problem>{`Couldn't check who is signed in: ${view.problem}`}</Problem>
        </>
      }
    >
      <Github className="h-2.5 w-2.5" />
      <TriangleAlert className="h-3 w-3 shrink-0" />
    </PopSegment>
  );
}
