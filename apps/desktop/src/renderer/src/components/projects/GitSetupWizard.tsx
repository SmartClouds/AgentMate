import type { GithubOwner, GithubRepoInfo, GithubRepoLookup } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Check,
  CircleCheck,
  CloudUpload,
  ExternalLink,
  GitBranch,
  Globe,
  Plus,
  RefreshCw,
  Search,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { queryKeys } from '@/lib/queryKeys';

const GH_INSTALL_URL = 'https://cli.github.com/';

/**
 * Each step of the wizard shows its own spinner in the button that is running, so these
 * writes opt out of the app-wide loading overlay (see `useAppLoadingOverlay`).
 */
const GIT_SETUP_META = { silentLoading: true } as const;

/** GitHub itself swaps anything outside this set for a dash, so do the same up front. */
function suggestRepoName(folderPath: string): string {
  const base = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

type Step = 'init' | 'github' | 'done';

export function GitSetupWizard({
  projectId,
  folderPath,
  isRepo,
  currentBranch,
  open,
  onOpenChange,
}: {
  projectId: string;
  folderPath: string;
  /** True when the folder already has a repository, so the wizard skips straight to GitHub. */
  isRepo: boolean;
  /** Branch of an existing repo, used to name what was pushed on the last step. */
  currentBranch: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>(isRepo ? 'github' : 'init');
  const [branch, setBranch] = useState('master');
  const [initialCommit, setInitialCommit] = useState(true);
  const [commitMessage, setCommitMessage] = useState('Initial commit');

  const [owner, setOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [description, setDescription] = useState('');
  const [useSsh, setUseSsh] = useState(false);
  const [lookup, setLookup] = useState<GithubRepoLookup | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [finishedRepoUrl, setFinishedRepoUrl] = useState<string | null>(null);
  /** Kept so the last step can name the branch even after the status query refreshes. */
  const pushedBranch = useRef<string | null>(null);

  const accountQuery = useQuery({
    queryKey: queryKeys.githubAccount,
    queryFn: () => window.runova.git.githubAccount(),
    enabled: open && step === 'github' && !manualMode,
    staleTime: 60_000,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the whole wizard each time it opens, not on every field change
  useEffect(() => {
    if (!open) return;
    setStep(isRepo ? 'github' : 'init');
    setBranch('master');
    setInitialCommit(true);
    setCommitMessage('Initial commit');
    setRepoName(suggestRepoName(folderPath));
    setIsPrivate(true);
    setDescription('');
    setUseSsh(false);
    setLookup(null);
    setManualUrl('');
    setManualMode(false);
    setFinishedRepoUrl(null);
    pushedBranch.current = null;
  }, [open]);

  // The signed-in account is the sensible default owner, and it is always first in the list.
  useEffect(() => {
    const owners = accountQuery.data?.owners;
    if (owners?.length && !owner) setOwner(owners[0].login);
  }, [accountQuery.data, owner]);

  function refreshGitState(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(projectId) });
  }

  const initMutation = useMutation({
    mutationFn: () => window.runova.git.init({ projectId, branch, initialCommit, commitMessage }),
    onSuccess: (result) => {
      refreshGitState();
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(result.message);
      pushedBranch.current = branch;
      setStep('github');
    },
    meta: GIT_SETUP_META,
  });

  const lookupMutation = useMutation({
    mutationFn: () => window.runova.git.lookupGithubRepo(owner, repoName),
    onSuccess: (result) => {
      setLookup(result);
      if (!result.ok) toast.error(result.error ?? 'Could not reach GitHub.');
    },
    meta: GIT_SETUP_META,
  });

  const connectMutation = useMutation({
    mutationFn: async (): Promise<{ message: string; repoUrl: string | null }> => {
      let repo: GithubRepoInfo | null = lookup?.repo ?? null;
      let url = manualMode ? manualUrl.trim() : '';

      if (!manualMode) {
        if (!repo) {
          const created = await window.runova.git.createGithubRepo({
            owner,
            name: repoName.trim(),
            isPrivate,
            description,
          });
          if (!created.ok || !created.repo) {
            throw new Error(created.error ?? 'Could not create the repository on GitHub.');
          }
          repo = created.repo;
        }
        url = useSsh ? repo.sshUrl : repo.cloneUrl;
      }

      const result = await window.runova.git.connectRemote({ projectId, url, push: true });
      if (!result.ok) throw new Error(result.message);
      return { message: result.message, repoUrl: repo?.htmlUrl ?? null };
    },
    onSuccess: ({ message, repoUrl }) => {
      refreshGitState();
      toast.success(message);
      setFinishedRepoUrl(repoUrl);
      setStep('done');
    },
    onError: (error: Error) => {
      refreshGitState();
      toast.error(error.message || 'Could not connect the repository.');
    },
    meta: GIT_SETUP_META,
  });

  const account = accountQuery.data;
  const ownerOptions =
    account?.owners.map((githubOwner: GithubOwner) => ({
      value: githubOwner.login,
      label:
        githubOwner.type === 'organization'
          ? `${githubOwner.login} (organization)`
          : `${githubOwner.login} (your account)`,
    })) ?? [];
  const repoExists = lookup?.ok === true && lookup.exists;
  const repoMissing = lookup?.ok === true && !lookup.exists;
  const canLookUp = owner.trim().length > 0 && repoName.trim().length > 0;

  function resetLookup(): void {
    setLookup(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {step === 'init' ? 'Set up git for this project' : 'Connect this project to GitHub'}
          </DialogTitle>
          <DialogDescription>
            {step === 'init'
              ? 'Creates a repository in the project folder, then walks you through publishing it to GitHub.'
              : 'Pick the account or organization to publish under, then push your first commit.'}
          </DialogDescription>
        </DialogHeader>

        <OverflowScroll fill>
          {step === 'init' && (
            <div className="space-y-3">
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">Folder</p>
                <p className="truncate font-mono text-xs">{folderPath}</p>
              </div>
              <div className="space-y-1.5">
                <Label>Initial branch</Label>
                <Input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="master"
                />
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={initialCommit}
                  onCheckedChange={(checked) => setInitialCommit(checked === true)}
                />
                Commit the files that are already in the folder
              </label>
              {initialCommit && (
                <div className="space-y-1.5">
                  <Label>Commit message</Label>
                  <Input
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    placeholder="Initial commit"
                  />
                </div>
              )}
            </div>
          )}

          {step === 'github' && (
            <div className="space-y-3">
              {manualMode ? (
                <>
                  <div className="space-y-1.5">
                    <Label>Remote URL</Label>
                    <Input
                      value={manualUrl}
                      onChange={(e) => setManualUrl(e.target.value)}
                      placeholder="https://github.com/owner/repo.git"
                    />
                    <p className="text-xs text-muted-foreground">
                      Set as origin, then the current branch is pushed with -u.
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setManualMode(false)}>
                    Back to the GitHub account
                  </Button>
                </>
              ) : accountQuery.isLoading ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="h-3.5 w-3.5 animate-spin" /> Checking your GitHub sign-in…
                </p>
              ) : !account?.cliAvailable || !account.authenticated ? (
                <div className="space-y-3">
                  <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <div className="space-y-1">
                      <p className="font-medium">
                        {account?.cliAvailable
                          ? 'The GitHub CLI is not signed in.'
                          : 'The GitHub CLI (gh) is not installed.'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {account?.cliAvailable
                          ? 'Run "gh auth login" in a terminal, then check again. It is what lets this app list your organizations and create repositories.'
                          : 'Install it to list your organizations and create a repository from here. You can also just paste a remote URL instead.'}
                      </p>
                      {account?.error && (
                        <p className="font-mono text-xs text-muted-foreground">{account.error}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!account?.cliAvailable && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void window.runova.shell.openExternal(GH_INSTALL_URL)}
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> Install the GitHub CLI
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={accountQuery.isFetching}
                      onClick={() => void accountQuery.refetch()}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Check again
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setManualMode(true)}>
                      Use a remote URL instead
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Signed in as{' '}
                    <span className="font-medium text-foreground">{account.login}</span>.
                  </p>
                  <div className="space-y-1.5">
                    <Label>Owner</Label>
                    <Combobox
                      options={ownerOptions}
                      value={owner}
                      onChange={(next) => {
                        setOwner(next);
                        resetLookup();
                      }}
                      placeholder="Select an account or organization…"
                      searchPlaceholder="Search organizations…"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Repository name</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        value={repoName}
                        onChange={(e) => {
                          setRepoName(e.target.value);
                          resetLookup();
                        }}
                        placeholder="my-project"
                      />
                      <Button
                        variant="soft"
                        className="h-9"
                        disabled={!canLookUp || lookupMutation.isPending}
                        onClick={() => lookupMutation.mutate()}
                      >
                        {lookupMutation.isPending ? (
                          <Spinner className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Search className="h-3.5 w-3.5" />
                        )}
                        Check
                      </Button>
                    </div>
                  </div>

                  {repoExists && lookup?.repo && (
                    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <CircleCheck className="h-4 w-4 text-success" /> {lookup.repo.fullName}{' '}
                        exists
                        <Badge variant="outline">
                          {lookup.repo.isPrivate ? 'Private' : 'Public'}
                        </Badge>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Origin will point at it and your current branch gets pushed. If the
                        repository already has commits, git will refuse the push until you pull them
                        first.
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void window.runova.shell.openExternal(lookup.repo?.htmlUrl ?? '')
                        }
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> Open on GitHub
                      </Button>
                    </div>
                  )}

                  {repoMissing && (
                    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <Plus className="h-4 w-4" /> No repository named {repoName} under {owner}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        It will be created for you, then connected and pushed.
                      </p>
                      <div className="space-y-1.5">
                        <Label>Description (optional)</Label>
                        <Input
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          placeholder="What this project is"
                        />
                      </div>
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <Checkbox
                          checked={isPrivate}
                          onCheckedChange={(checked) => setIsPrivate(checked === true)}
                        />
                        {isPrivate ? (
                          'Private repository'
                        ) : (
                          <span className="flex items-center gap-1.5">
                            <Globe className="h-3.5 w-3.5" /> Public repository
                          </span>
                        )}
                      </label>
                    </div>
                  )}

                  {(repoExists || repoMissing) && (
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={useSsh}
                        onCheckedChange={(checked) => setUseSsh(checked === true)}
                      />
                      Connect over SSH instead of HTTPS
                    </label>
                  )}

                  <Button variant="ghost" size="sm" onClick={() => setManualMode(true)}>
                    Use a remote URL instead
                  </Button>
                </>
              )}
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CircleCheck className="h-4 w-4 text-success" /> Pushed{' '}
                {pushedBranch.current ?? currentBranch ?? 'your branch'} to origin.
              </p>
              {finishedRepoUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void window.runova.shell.openExternal(finishedRepoUrl)}
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open the repository on GitHub
                </Button>
              )}
            </div>
          )}
        </OverflowScroll>

        <DialogFooter>
          {step === 'init' && (
            <Button
              disabled={initMutation.isPending || !branch.trim()}
              onClick={() => initMutation.mutate()}
            >
              {initMutation.isPending ? (
                <Spinner className="h-4 w-4 animate-spin" />
              ) : (
                <GitBranch className="h-4 w-4" />
              )}
              Initialize repository
            </Button>
          )}
          {step === 'github' && (
            <Button
              disabled={
                connectMutation.isPending ||
                (manualMode ? !manualUrl.trim() : !repoExists && !repoMissing)
              }
              onClick={() => connectMutation.mutate()}
            >
              {connectMutation.isPending ? (
                <Spinner className="h-4 w-4 animate-spin" />
              ) : (
                <CloudUpload className="h-4 w-4" />
              )}
              {repoMissing && !manualMode ? 'Create repository and push' : 'Connect and push'}
            </Button>
          )}
          {step === 'done' && (
            <Button onClick={() => onOpenChange(false)}>
              <Check className="h-4 w-4" /> Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
