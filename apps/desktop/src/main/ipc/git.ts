import type { GitChangeEntry, Project } from '@agentmat/core';
import {
  browsableRepoUrl,
  buildCommitMessagePrompt,
  normalizeCloneUrl,
  stripRemoteCredentials,
} from '@agentmat/core';
import { ipcMain } from 'electron';
import type {
  ApplyVersionInput,
  ApplyVersionResult,
  CloneIntoInput,
  CloneIntoResult,
  CloneProjectInput,
  CloneProjectResult,
  ConnectRemoteInput,
  CreateGithubRepoInput,
  CreateGithubRepoResult,
  CreatePullRequestInput,
  CreatePullRequestResult,
  CreateTagInput,
  DeleteBranchInput,
  GitApplyLinesInput,
  GitBranchHistory,
  GitDiffSide,
  GitDiscardResult,
  GitFileDiff,
  GithubAccount,
  GithubActivity,
  GithubNotifications,
  GithubRepoLookup,
  GitImageDiff,
  GitInitInput,
  GitOpResult,
  GitStashEntry,
  GitStashPushInput,
  GitStatus,
  GitTagInfo,
  RenameBranchInput,
  ResolveConflictWithAiResult,
  SuggestGitTextResult,
  SuggestTagResult,
  SwapVersionFileInput,
  WorkspaceGitState,
  WriteVersionHunksInput,
  WriteVersionHunksResult,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { cancelHeadlessPrompt, runHeadlessCliPrompt } from '../cli/headlessPrompt';
import {
  buildConflictResolutionPrompt,
  hasConflictMarkers,
  readConflictedText,
  resolutionSummary,
} from '../git/aiConflict';
import { cloneIntoFolder, cloneOrAttach } from '../git/cloneRepo';
import {
  GITHUB_NAME_PATTERN,
  type GithubApiRepo,
  markGithubNotificationRead,
  markGithubNotificationsRead,
  readGithubAccount,
  readGithubActivity,
  readGithubNotifications,
  toRepoInfo,
} from '../git/githubAccount';
import {
  ghApi,
  ghErrorMessage,
  isGhCliAvailable,
  parseGithubRemote,
  runGh,
} from '../git/githubCli';
import {
  checkoutBranch,
  createBranch,
  currentBranch,
  deleteBranch,
  detectDefaultBranch,
  git,
  gitOrNull,
  isGitRepo,
  listRepoFiles,
  PUSH_TIMEOUT_MS,
  primaryRemote,
  pushBranchAndTag,
  pushCurrentBranch,
  readBranchHistory,
  readChangeSummary,
  readCommitSubjects,
  readStatus,
  readTagInfo,
  renameBranch,
  runGitOp,
  safeBranchName,
  setDefaultBranch,
  TAG_NAME_PATTERN,
} from '../git/plumbing';
import { unwatchProjectRepo, watchProjectRepo } from '../git/repoWatcher';
import {
  buildReleaseSummary,
  buildVersionBumpPrompt,
  bumpVersion,
  deriveNextVersion,
  extractTagNotes,
  fallbackTagMessage,
  formatTagForRepo,
  parseBumpKind,
  parseSemver,
  parseSuggestedTag,
  rejectSuggestedVersion,
} from '../git/versioning';
import {
  compareSnapshots,
  repoRoot,
  snapshotChangedFiles,
  swapFileVersion,
  writeFileHunks,
} from '../git/versionReview';
import {
  refreshWorkspaceState,
  unwatchWorkingTree,
  watchWorkingTree,
} from '../git/workingTreeWatcher';
import {
  abortOperation,
  applyLineChange,
  assertCommitHash,
  assertLineRanges,
  assertRepoPaths,
  backupPaths,
  commitStaged,
  discardPaths,
  listStashes,
  locateRepo,
  readCommitFileDiff,
  readCommitFileImageDiff,
  readCommitFiles,
  readFileDiff,
  readFileImageDiff,
  readWorkspaceGitState,
  resolveConflict,
  stagePaths,
  stashDrop,
  stashPush,
  stashRestore,
  undoDiscard,
  unstagePaths,
  writeWorkingFile,
} from '../git/workspaceGit';
import { showOsNotification } from '../notifications/osNotification';
import { schedulePipelineCheck } from '../pipelines/watcher';
import { store } from '../store';
import { findProjectScope } from '../worktrees/resolve';

const GH_TIMEOUT_MS = 30000;
/**
 * The version bump sends the agent hunting through the repo for manifests before it edits
 * anything, and some CLIs hand that search to a sub-agent. Three minutes, which is plenty
 * for a one-question prompt, routinely cuts that off halfway.
 */
const VERSION_BUMP_TIMEOUT_MS = 900000;
/** The agent reads the file and maybe its neighbours before editing, so a bare prompt's budget is short. */
const CONFLICT_RESOLVE_TIMEOUT_MS = 600000;

/**
 * Origin can point at a folder, a UNC share or a file:// URL. Those clone fine but
 * are nothing to hand a browser, so the project's repository link stays empty.
 */
const LOCAL_REMOTE_PATTERN = /^([a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|file:)/i;

const NOT_CLONABLE_MESSAGE = 'That address cannot be cloned. Use a github.com/owner/repo link.';

/** The project, or for a worktree's workspace (a scope id) the project pointed at the worktree. */
async function getProject(projectId: string): Promise<Project> {
  const project = await findProjectScope(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  return project;
}

async function getProjectPath(projectId: string): Promise<string> {
  return (await getProject(projectId)).folderPath;
}

/**
 * The shared body of the "ask the CLI to write something about my changes"
 * handlers: they differ only in the prompt they build around the change summary.
 */
async function suggestGitText(
  projectId: string,
  buildPrompt: (summary: string) => string,
  requestId?: string,
  stagedOnly = false,
  cliId: string | null = null,
): Promise<SuggestGitTextResult> {
  const project = await getProject(projectId);
  const summary = await readChangeSummary(project.folderPath, { stagedOnly });
  const result = await runHeadlessCliPrompt(buildPrompt(summary), project.folderPath, {
    requestId,
    preferredCliId: cliId ?? project.cliId,
  });
  return {
    ok: result.ok,
    text: result.text,
    cliName: result.cliName,
    error: result.error,
    cancelled: result.cancelled,
  };
}

function registerRepoHandlers(): void {
  ipcMain.handle(IPC.git.status, async (_event, projectId: string): Promise<GitStatus> => {
    return readStatus(await getProjectPath(projectId));
  });

  ipcMain.handle(IPC.git.watchRepo, async (event, projectId: string): Promise<void> => {
    watchProjectRepo(projectId, await getProjectPath(projectId), event.sender);
  });

  ipcMain.handle(IPC.git.unwatchRepo, (event, projectId: string): void => {
    unwatchProjectRepo(projectId, event.sender);
  });

  ipcMain.handle(IPC.git.listFiles, async (_event, projectId: string): Promise<string[]> => {
    return listRepoFiles(await getProjectPath(projectId));
  });

  ipcMain.handle(IPC.git.changeSummary, async (_event, projectId: string): Promise<string> => {
    return readChangeSummary(await getProjectPath(projectId));
  });

  ipcMain.handle(IPC.git.fetch, async (_event, projectId: string): Promise<GitOpResult> => {
    const cwd = await getProjectPath(projectId);
    return runGitOp(() => git(cwd, ['fetch', '--all', '--prune']));
  });

  ipcMain.handle(IPC.git.pull, async (_event, projectId: string): Promise<GitOpResult> => {
    const cwd = await getProjectPath(projectId);
    return runGitOp(() => git(cwd, ['pull']));
  });

  ipcMain.handle(IPC.git.push, async (_event, projectId: string): Promise<GitOpResult> => {
    const cwd = await getProjectPath(projectId);
    const result = await runGitOp(async () => {
      // The branch name is all this needs; a full readStatus would spend another
      // ten subprocesses listing branches and diffing the tree for nothing.
      const branch = await currentBranch(cwd);
      if (!branch) throw new Error('No current branch to push.');
      return pushCurrentBranch(cwd, branch);
    });
    if (result.ok) schedulePipelineCheck(projectId);
    return result;
  });

  ipcMain.handle(IPC.git.sync, async (_event, projectId: string): Promise<GitOpResult> => {
    const cwd = await getProjectPath(projectId);
    const result = await runGitOp(async () => {
      const fetchOut = await git(cwd, ['fetch', '--all', '--prune']);
      const pullOut = await git(cwd, ['pull']);
      const branch = await currentBranch(cwd);
      const pushOut = branch ? await pushCurrentBranch(cwd, branch) : '';
      return [fetchOut, pullOut, pushOut].filter(Boolean).join('\n');
    });
    if (result.ok) schedulePipelineCheck(projectId);
    return result;
  });

  ipcMain.handle(
    IPC.git.commit,
    async (_event, projectId: string, message: string, paths?: string[]): Promise<GitOpResult> => {
      const cwd = await getProjectPath(projectId);
      if (!message.trim()) return { ok: false, message: 'Commit message cannot be empty.' };
      if (paths !== undefined) {
        const picked = paths.filter((path) => typeof path === 'string' && path.trim());
        if (picked.length === 0) return { ok: false, message: 'There are no files to commit.' };
        // Only the named files go in, so anything else already sitting in the tree stays out
        // of the commit. The paths are repo-relative and taken literally, not as globs.
        return runGitOp(async () => {
          const root = await repoRoot(cwd);
          await git(root, ['--literal-pathspecs', 'add', '-A', '--', ...picked]);
          return git(root, [
            '--literal-pathspecs',
            'commit',
            '-m',
            message,
            '--only',
            '--',
            ...picked,
          ]);
        });
      }
      return runGitOp(async () => {
        await git(cwd, ['add', '-A']);
        return git(cwd, ['commit', '-m', message]);
      });
    },
  );

  ipcMain.handle(IPC.git.init, async (_event, input: GitInitInput): Promise<GitOpResult> => {
    const cwd = await getProjectPath(input.projectId);
    let branch: string;
    try {
      branch = safeBranchName(input.branch);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    if (await isGitRepo(cwd)) {
      return { ok: false, message: 'This folder is already a git repository.' };
    }

    return runGitOp(async () => {
      try {
        await git(cwd, ['init', '-b', branch]);
      } catch {
        // git older than 2.28 has no --initial-branch, so point HEAD at the branch by hand.
        await git(cwd, ['init']);
        await git(cwd, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      }

      if (!input.initialCommit) return `Initialized an empty repository on ${branch}.`;

      await git(cwd, ['add', '-A']);
      const staged = ((await gitOrNull(cwd, ['diff', '--cached', '--name-only'])) ?? '').trim();
      if (!staged) {
        return `Initialized an empty repository on ${branch}. There was nothing to commit yet.`;
      }
      await git(cwd, ['commit', '-m', input.commitMessage?.trim() || 'Initial commit']);
      return `Initialized the repository on ${branch} and committed the current files.`;
    });
  });

  ipcMain.handle(
    IPC.git.connectRemote,
    async (_event, input: ConnectRemoteInput): Promise<GitOpResult> => {
      const cwd = await getProjectPath(input.projectId);
      const url = input.url.trim();
      if (!url) return { ok: false, message: 'Remote URL cannot be empty.' };
      if (!/^(https?:\/\/|ssh:\/\/|git@)/i.test(url)) {
        return { ok: false, message: 'The remote must be an https or ssh git URL.' };
      }
      if (!(await isGitRepo(cwd))) {
        return { ok: false, message: 'This folder is not a git repository yet.' };
      }

      // A remote can carry a token in its userinfo; git needs it, the message
      // shown back to the user (and whatever logs it) does not.
      const shownUrl = stripRemoteCredentials(url);

      return runGitOp(async () => {
        const remotes = ((await gitOrNull(cwd, ['remote'])) ?? '')
          .split('\n')
          .map((remote) => remote.trim())
          .filter(Boolean);
        if (remotes.includes('origin')) {
          await git(cwd, ['remote', 'set-url', 'origin', url]);
        } else {
          await git(cwd, ['remote', 'add', 'origin', url]);
        }
        if (!input.push) return `Connected origin to ${shownUrl}.`;

        const hasCommit = (await gitOrNull(cwd, ['rev-parse', '--verify', 'HEAD'])) !== null;
        if (!hasCommit) {
          return `Connected origin to ${shownUrl}. There is nothing to push until you make a commit.`;
        }

        const branch = await currentBranch(cwd);
        if (!branch) throw new Error('No current branch to push, HEAD is detached.');
        await git(cwd, ['push', '-u', 'origin', branch], PUSH_TIMEOUT_MS);
        return `Connected origin and pushed ${branch}.`;
      });
    },
  );

  /**
   * Origin's URL for a folder on disk, addressed by path rather than project id:
   * the new-project form needs this before the project exists. Null when the
   * folder isn't a repository or has no origin, which is not an error worth showing.
   */
  ipcMain.handle(
    IPC.git.detectRemote,
    async (_event, folderPath: string): Promise<string | null> => {
      const cwd = folderPath?.trim();
      if (!cwd || !(await isGitRepo(cwd))) return null;
      const remote = ((await gitOrNull(cwd, ['remote', 'get-url', 'origin'])) ?? '').trim();
      if (!remote || LOCAL_REMOTE_PATTERN.test(remote)) return null;
      // browsableRepoUrl drops any embedded credentials, which matters because
      // this value is prefilled into the project form, stored, shown, and later
      // handed to shell.openExternal.
      return browsableRepoUrl(remote);
    },
  );

  /**
   * Clones a public or (with gh signed in) private GitHub repo into the folder picked in
   * New Project. Blocks on a non-empty folder and skips when the folder already holds a
   * repo. Never throws: the renderer still creates the project when the clone fails, and
   * the Git tab's Clone from GitHub picks it up from there.
   */
  ipcMain.handle(
    IPC.git.cloneInto,
    async (_event, input: CloneIntoInput): Promise<CloneIntoResult> => {
      const folder = input?.folderPath?.trim() ?? '';
      if (!folder) return { ok: false, message: 'Pick a folder to clone into.' };
      const normalized = normalizeCloneUrl(input?.repoUrl ?? '');
      if (!normalized) return { ok: false, message: NOT_CLONABLE_MESSAGE };
      try {
        const outcome = await cloneIntoFolder(folder, normalized);
        return { ok: outcome.ok, message: outcome.message, skipped: outcome.mode === 'skipped' };
      } catch (error) {
        return { ok: false, message: (error as Error)?.message || 'Clone failed.' };
      }
    },
  );

  /**
   * Gets an existing project's GitHub repo onto this computer: a clone for an empty or
   * missing folder, or for a folder that already has files, attaching it in place once the
   * user has confirmed. This is how a clone that failed at create time is retried.
   */
  ipcMain.handle(
    IPC.git.cloneProject,
    async (_event, input: CloneProjectInput): Promise<CloneProjectResult> => {
      const project = await getProject(input.projectId);
      const normalized = normalizeCloneUrl(input.repoUrl?.trim() || project.repoUrl || '');
      if (!normalized) return { ok: false, message: NOT_CLONABLE_MESSAGE };
      try {
        return await cloneOrAttach(project.folderPath, normalized, input.attach === true);
      } catch (error) {
        return { ok: false, message: (error as Error)?.message || 'Clone failed.' };
      }
    },
  );
}

function registerBranchHandlers(): void {
  ipcMain.handle(
    IPC.git.createBranch,
    async (_event, projectId: string, branchName: string): Promise<GitOpResult> => {
      const cwd = await getProjectPath(projectId);
      return runGitOp(() => createBranch(cwd, branchName));
    },
  );

  ipcMain.handle(
    IPC.git.checkoutBranch,
    async (_event, projectId: string, branchName: string): Promise<GitOpResult> => {
      const cwd = await getProjectPath(projectId);
      return runGitOp(() => checkoutBranch(cwd, branchName));
    },
  );

  ipcMain.handle(
    IPC.git.setDefaultBranch,
    async (_event, projectId: string, branchName: string): Promise<GitOpResult> => {
      const cwd = await getProjectPath(projectId);
      return runGitOp(() => setDefaultBranch(cwd, branchName));
    },
  );

  ipcMain.handle(
    IPC.git.renameBranch,
    async (_event, input: RenameBranchInput): Promise<GitOpResult> => {
      const cwd = await getProjectPath(input.projectId);
      return runGitOp(() => renameBranch(cwd, input.from, input.to, Boolean(input.updateRemote)));
    },
  );

  ipcMain.handle(
    IPC.git.deleteBranch,
    async (_event, input: DeleteBranchInput): Promise<GitOpResult> => {
      const cwd = await getProjectPath(input.projectId);
      return runGitOp(() =>
        deleteBranch(cwd, input.branchName, {
          deleteRemote: Boolean(input.deleteRemote),
          force: Boolean(input.force),
        }),
      );
    },
  );

  ipcMain.handle(
    IPC.git.branchHistory,
    async (_event, projectId: string, branchName: string): Promise<GitBranchHistory> => {
      return readBranchHistory(await getProjectPath(projectId), branchName);
    },
  );

  ipcMain.handle(
    IPC.git.suggestBranchName,
    async (_event, projectId: string, requestId?: string): Promise<SuggestGitTextResult> => {
      return suggestGitText(
        projectId,
        (summary) =>
          'Generate a single short git branch name (kebab-case, e.g. "feat/add-login" or ' +
          '"fix/null-check", max 60 characters, no spaces, no quotes, no markdown) describing these ' +
          'uncommitted changes. Do not read or edit any files; judge only from the information below. ' +
          `Reply with ONLY the branch name and nothing else.\n\n${summary}`,
        requestId,
      );
    },
  );

  ipcMain.handle(IPC.git.cancelSuggestBranchName, (_event, requestId: string): boolean => {
    return cancelHeadlessPrompt(requestId);
  });

  ipcMain.handle(
    IPC.git.suggestCommitMessage,
    async (
      _event,
      projectId: string,
      requestId?: string,
      scope?: 'staged' | 'all',
    ): Promise<SuggestGitTextResult> => {
      // The style, extra rules and writing CLI come from Settings > Commit messages.
      const { commitMessage } = await store.getSettings();
      return suggestGitText(
        projectId,
        (summary) => buildCommitMessagePrompt(commitMessage, summary),
        requestId,
        scope === 'staged',
        commitMessage.cliId,
      );
    },
  );

  ipcMain.handle(IPC.git.cancelSuggestCommitMessage, (_event, requestId: string): boolean => {
    return cancelHeadlessPrompt(requestId);
  });
}

function registerTagHandlers(): void {
  ipcMain.handle(
    IPC.git.tags,
    async (_event, projectId: string, prefix?: string): Promise<GitTagInfo> => {
      return readTagInfo(await getProjectPath(projectId), prefix);
    },
  );

  ipcMain.handle(IPC.git.createTag, async (_event, input: CreateTagInput): Promise<GitOpResult> => {
    const cwd = await getProjectPath(input.projectId);
    const tag = input.tag.trim();
    if (!tag) return { ok: false, message: 'Tag name cannot be empty.' };
    if (!TAG_NAME_PATTERN.test(tag) || tag.includes('..') || tag.includes('@{')) {
      return {
        ok: false,
        message:
          'Invalid tag name. Use letters, digits, dots, dashes, underscores, slashes or @ (e.g. v1.0.1 or web-v1.0.1).',
      };
    }

    const localSha = (
      await gitOrNull(cwd, ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`])
    )?.trim();

    if (localSha) {
      // The tag is already there locally, most often because the version-bump CLI ran a tool
      // like `npm version` that tags on its own despite being told not to. As long as it still
      // points at HEAD, treat this as "already made, just needs pushing" instead of a conflict.
      const headSha = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
      if (localSha !== headSha) {
        return {
          ok: false,
          message: `Tag ${tag} already exists locally but points at a different commit than HEAD. Delete it (or pick a different name) before retrying.`,
        };
      }
      if (!input.push) return { ok: false, message: `Tag ${tag} already exists locally.` };

      const existingResult = await runGitOp(async () => {
        const remote = (await primaryRemote(cwd)) ?? 'origin';
        // Annotated tags list under their own object sha; the "^{}" peeled ref is what
        // resolves that back to the commit, which is what `localSha` was compared against above.
        const remoteRefs = (
          (await gitOrNull(cwd, [
            'ls-remote',
            remote,
            `refs/tags/${tag}`,
            `refs/tags/${tag}^{}`,
          ])) ?? ''
        )
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const peeled = remoteRefs.find((line) => line.endsWith('^{}'));
        const remoteSha = (peeled ?? remoteRefs[0])?.split(/\s+/)[0];
        if (remoteSha && remoteSha !== localSha) {
          throw new Error(
            `Tag ${tag} already exists on ${remote} and points at a different commit.`,
          );
        }
        await pushBranchAndTag(cwd, tag);
        return remoteSha
          ? `Tag ${tag} already exists locally and on ${remote}.`
          : `Tag ${tag} already existed locally, pushed the branch and tag to ${remote}.`;
      });
      if (existingResult.ok) schedulePipelineCheck(input.projectId);
      return existingResult;
    }

    const createdResult = await runGitOp(async () => {
      await git(cwd, ['tag', '-a', tag, '-m', input.message?.trim() || tag]);
      if (!input.push) return `Created tag ${tag} locally.`;
      try {
        await pushBranchAndTag(cwd, tag);
      } catch (error) {
        // Leave the repo as we found it so the user can retry the same tag after fixing the remote.
        await gitOrNull(cwd, ['tag', '-d', tag]);
        throw error;
      }
      return `Created tag ${tag} and pushed the branch and tag to origin.`;
    });
    if (createdResult.ok && input.push) schedulePipelineCheck(input.projectId);
    return createdResult;
  });

  ipcMain.handle(
    IPC.git.suggestTag,
    async (
      _event,
      projectId: string,
      requestId?: string,
      prefix?: string,
    ): Promise<SuggestTagResult> => {
      const project = await getProject(projectId);
      const cwd = project.folderPath;
      const { latestTag, commitsSinceLatestTag } = await readTagInfo(cwd, prefix);
      if (latestTag && commitsSinceLatestTag === 0) {
        return {
          ok: false,
          error: `No new commits since ${latestTag}, so there is nothing to tag yet.`,
        };
      }

      const subjects = await readCommitSubjects(cwd, latestTag);
      const diffStat = latestTag
        ? ((await gitOrNull(cwd, ['diff', '--shortstat', `${latestTag}..HEAD`])) ?? '').trim()
        : '';
      const summary = buildReleaseSummary(latestTag, subjects, diffStat);
      const namedSeries = prefix !== undefined && prefix !== '' && prefix.toLowerCase() !== 'v';
      const prompt =
        'You are picking the next git tag for a release, following semantic versioning: bump the major ' +
        'version for breaking changes, the minor version for new features, the patch version for fixes ' +
        'and chores only. Do not read or edit any files; judge only from the information below.\n\n' +
        (namedSeries ? `Tags in this series are named ${prefix}<version>.\n\n` : '') +
        (latestTag
          ? `The ${namedSeries ? 'latest tag in this series' : "repository's latest tag"} is ${latestTag}. ` +
            'Your answer MUST be a bump of exactly that version and must be greater than it. ' +
            'Never invent an unrelated version number.\n\n'
          : '') +
        'Answer in exactly this format, with no markdown and nothing else:\n' +
        'TAG: <the new tag>\n' +
        'WHY: <one short sentence explaining the bump>\n' +
        'NOTES:\n' +
        '<release notes for the tag annotation: a one-line summary, then a few "- " bullets ' +
        'grouping the notable changes. Keep it under 15 lines.>\n\n' +
        summary;

      const result = await runHeadlessCliPrompt(prompt, cwd, {
        requestId,
        preferredCliId: project.cliId,
      });
      if (!result.ok) {
        return {
          ok: false,
          cliName: result.cliName,
          error: result.error,
          cancelled: result.cancelled,
        };
      }

      // The typed prefix is put back on whatever the model answered, so a `web-v` release
      // never comes back as a bare `v1.4.0` or with some other prefix the model made up.
      const parsed = parseSuggestedTag(result.text, latestTag, prefix);
      const notes = extractTagNotes(result.text);
      const latestParts = latestTag ? parseSemver(latestTag) : null;

      // Models often skip a concrete semver ("TAG: patch", prose only, etc.). When we
      // already know the latest tag, turn that into a real bump instead of failing the run.
      let tag = parsed?.tag;
      let reason = parsed?.reason ?? notes.reason;
      if (!tag && latestParts) {
        const bumpKind = parseBumpKind(result.text);
        const derived = bumpKind
          ? bumpVersion(latestParts, bumpKind)
          : deriveNextVersion(latestParts, subjects);
        tag = formatTagForRepo(derived, latestTag, prefix);
        reason = bumpKind
          ? `${result.cliName} suggested a ${bumpKind} bump; used ${tag}.`
          : `${result.cliName} did not return a version number; used ${tag} from the commit history instead.`;
      }

      if (!tag) {
        return {
          ok: false,
          cliName: result.cliName,
          error: `${result.cliName} did not return a version number.`,
        };
      }

      // Models regularly answer with a stock version ("1.2.3") that has nothing to do with
      // the repo. Anything that isn't a plausible bump of the latest tag is dropped in
      // favour of one derived from the commits themselves.
      if (latestParts && latestTag) {
        const problem = rejectSuggestedVersion(parseSemver(tag), latestParts, latestTag);
        if (problem) {
          const rejected = tag;
          tag = formatTagForRepo(deriveNextVersion(latestParts, subjects), latestTag, prefix);
          reason = `${result.cliName} suggested ${rejected}, which ${problem}; used ${tag} from the commit history instead.`;
        }
      }

      return {
        ok: true,
        tag,
        reason,
        // A CLI that ignored the NOTES section still gets a usable annotation, straight from the log.
        message: parsed?.message || notes.message || fallbackTagMessage(tag, subjects),
        cliName: result.cliName,
      };
    },
  );

  ipcMain.handle(IPC.git.cancelSuggestTag, (_event, requestId: string): boolean => {
    return cancelHeadlessPrompt(requestId);
  });

  ipcMain.handle(
    IPC.git.applyVersion,
    async (_event, input: ApplyVersionInput): Promise<ApplyVersionResult> => {
      const project = await getProject(input.projectId);
      const cwd = project.folderPath;
      const tag = input.tag.trim();
      if (!tag) {
        return { ok: false, output: '', changes: [], error: 'No version to apply.' };
      }

      // Snapshot first: the CLI's own summary of what it edited can't be trusted, and
      // comparing file contents before and after is the only account of it that can.
      const root = (await repoRoot(cwd).catch(() => '')) || cwd;
      const before = await snapshotChangedFiles(root);
      const headBefore = (await gitOrNull(cwd, ['rev-parse', 'HEAD']))?.trim() ?? null;

      const result = await runHeadlessCliPrompt(buildVersionBumpPrompt(tag), cwd, {
        requestId: input.requestId,
        preferredCliId: project.cliId,
        allowWrites: true,
        timeoutMs: VERSION_BUMP_TIMEOUT_MS,
      });

      // The CLI may edit anything, so every file it touched is listed for the user to keep
      // or revert, rather than guessing up front which ones belong to this release.
      const after = await snapshotChangedFiles(root);
      const changes = await compareSnapshots(root, before, after);

      // Despite the prompt telling it not to, a CLI occasionally reaches for a tool like
      // `npm version` that commits (and tags) by itself; that leaves no working-tree diff to
      // report, so this is the only way to tell the UI the bump actually landed in a commit.
      const headAfter = (await gitOrNull(cwd, ['rev-parse', 'HEAD']))?.trim() ?? null;
      const committedByCli = headBefore !== null && headAfter !== null && headBefore !== headAfter;

      // Agent CLIs are unreliable narrators of their own exit: OpenCode ends a run whose
      // last act was a tool call with an empty stdout, and a run we stop for running long
      // exits non-zero. Neither says the bump failed, and the working tree above already
      // knows whether it landed. A cancel still reads as a cancel, since the user asked.
      const landed = (changes.length > 0 || committedByCli) && !result.cancelled;

      const applyResult: ApplyVersionResult = {
        ok: result.ok || landed,
        // Falls back to the progress log for CLIs that keep stdout for the final message
        // and print everything they did to stderr.
        output: result.text || result.log || '',
        changes,
        committedByCli,
        cliName: result.cliName,
        // A run that wrote files but ended badly is a partial success, not a failure: say
        // what went wrong without burying the edits the user now has to deal with.
        warning: landed && !result.ok ? result.error : undefined,
        error: result.ok || landed ? undefined : result.error,
        cancelled: result.cancelled,
      };

      // The run can take minutes, so this says it's done even if the dialog watching it has
      // since closed or the user moved to another project or page entirely. Clicking it
      // reopens the review, same as the in-app toast the still-open dialog would show.
      if (!applyResult.cancelled) {
        const settings = await store.getSettings();
        if (settings.workspaceNotifications !== false) {
          showOsNotification({
            title: applyResult.ok
              ? `${project.name}: version files updated`
              : `${project.name}: version update failed`,
            body: applyResult.ok
              ? `${changes.length} file${changes.length === 1 ? '' : 's'} changed for ${tag}. Review and commit when ready.`
              : (applyResult.error ?? 'The CLI did not finish.'),
            route: `/workspace/${input.projectId}?tag=1`,
          });
        }
      }

      return applyResult;
    },
  );

  ipcMain.handle(IPC.git.cancelApplyVersion, (_event, requestId: string): boolean => {
    return cancelHeadlessPrompt(requestId);
  });

  ipcMain.handle(
    IPC.git.swapVersionFile,
    async (_event, input: SwapVersionFileInput): Promise<GitOpResult> => {
      const cwd = await getProjectPath(input.projectId);
      return runGitOp(async () => {
        const root = await repoRoot(cwd);
        await swapFileVersion(root, input.path, input.fromId, input.toId, input.toRawId);
        return input.toId === null ? `Removed ${input.path}.` : `Updated ${input.path}.`;
      });
    },
  );

  ipcMain.handle(
    IPC.git.writeVersionHunks,
    async (_event, input: WriteVersionHunksInput): Promise<WriteVersionHunksResult> => {
      const cwd = await getProjectPath(input.projectId);
      let id: string | undefined;
      const result = await runGitOp(async () => {
        id = await writeFileHunks(await repoRoot(cwd), input);
        return `Updated ${input.path}.`;
      });
      return result.ok ? { ...result, id } : result;
    },
  );
}

function registerGithubHandlers(): void {
  ipcMain.handle(
    IPC.git.createPullRequest,
    async (_event, input: CreatePullRequestInput): Promise<CreatePullRequestResult> => {
      const cwd = await getProjectPath(input.projectId);
      const branch = await currentBranch(cwd);
      if (!branch) return { ok: false, error: 'No current branch found.' };

      try {
        await pushCurrentBranch(cwd, branch);
      } catch (error) {
        const err = error as { stderr?: string; message?: string };
        return {
          ok: false,
          error: `Failed to push branch before creating the PR: ${(err.stderr || err.message || '').trim()}`,
        };
      }

      if (await isGhCliAvailable()) {
        try {
          const args = ['pr', 'create', '--title', input.title, '--body', input.body];
          if (input.base) args.push('--base', input.base);
          if (input.draft) args.push('--draft');
          const { stdout } = await runGh(args, { cwd, timeout: GH_TIMEOUT_MS });
          const url = stdout.trim().split('\n').pop() ?? '';
          return { ok: true, url };
        } catch (error) {
          return { ok: false, error: `gh pr create failed: ${ghErrorMessage(error)}` };
        }
      }

      // No GitHub CLI, fall back to opening a pre-filled compare page in the browser.
      // The remote is resolved the same way as everywhere else in this file, so a repo
      // whose only remote is called something other than origin still works.
      const remote = (await primaryRemote(cwd)) ?? 'origin';
      const remoteUrl = ((await gitOrNull(cwd, ['remote', 'get-url', remote])) ?? '').trim();
      const parsed = parseGithubRemote(remoteUrl);
      if (!parsed) {
        return {
          ok: false,
          error: `GitHub CLI (gh) is not installed and the ${remote} remote is not a GitHub URL.`,
        };
      }
      const base = input.base || (await detectDefaultBranch(cwd)) || 'main';
      const params = new URLSearchParams({ expand: '1', title: input.title, body: input.body });
      const url = `https://github.com/${parsed.owner}/${parsed.repo}/compare/${base}...${branch}?${params.toString()}`;
      return { ok: true, url, usedFallback: true };
    },
  );

  ipcMain.handle(IPC.git.githubAccount, async (): Promise<GithubAccount> => readGithubAccount());

  ipcMain.handle(IPC.git.githubActivity, async (): Promise<GithubActivity> => readGithubActivity());

  ipcMain.handle(
    IPC.git.githubNotifications,
    async (): Promise<GithubNotifications> => readGithubNotifications(),
  );

  ipcMain.handle(
    IPC.git.githubMarkNotificationRead,
    async (_event, threadId: string): Promise<GitOpResult> => markGithubNotificationRead(threadId),
  );

  ipcMain.handle(
    IPC.git.githubMarkNotificationsRead,
    async (): Promise<GitOpResult> => markGithubNotificationsRead(),
  );

  ipcMain.handle(
    IPC.git.lookupGithubRepo,
    async (_event, owner: string, name: string): Promise<GithubRepoLookup> => {
      const cleanOwner = owner.trim();
      const cleanName = name.trim().replace(/\.git$/i, '');
      if (!GITHUB_NAME_PATTERN.test(cleanOwner) || !GITHUB_NAME_PATTERN.test(cleanName)) {
        return {
          ok: false,
          exists: false,
          error:
            'Owner and repository names can only hold letters, digits, dots, dashes and underscores.',
        };
      }
      if (!(await isGhCliAvailable())) {
        return { ok: false, exists: false, error: 'GitHub CLI (gh) is not installed.' };
      }

      try {
        const repo = await ghApi<GithubApiRepo>(`repos/${cleanOwner}/${cleanName}`);
        return { ok: true, exists: true, repo: toRepoInfo(repo) };
      } catch (error) {
        const message = ghErrorMessage(error);
        // A 404 is the answer we asked for ("there is no such repo"), not a failure.
        if (/\b404\b|not found/i.test(message)) return { ok: true, exists: false };
        return { ok: false, exists: false, error: message };
      }
    },
  );

  ipcMain.handle(
    IPC.git.createGithubRepo,
    async (_event, input: CreateGithubRepoInput): Promise<CreateGithubRepoResult> => {
      const owner = input.owner.trim();
      const name = input.name.trim().replace(/\.git$/i, '');
      if (!GITHUB_NAME_PATTERN.test(owner) || !GITHUB_NAME_PATTERN.test(name)) {
        return {
          ok: false,
          error:
            'Owner and repository names can only hold letters, digits, dots, dashes and underscores.',
        };
      }

      const account = await readGithubAccount();
      if (!account.authenticated) {
        return {
          ok: false,
          error: account.cliAvailable
            ? `Not signed in to the GitHub CLI. Run "gh auth login" first.${account.error ? ` (${account.error})` : ''}`
            : 'GitHub CLI (gh) is not installed.',
        };
      }

      // Repos live under either the account itself or one of its organizations, and
      // GitHub has a separate endpoint for each.
      const isPersonal = owner.toLowerCase() === (account.login ?? '').toLowerCase();
      const endpoint = isPersonal ? 'user/repos' : `orgs/${owner}/repos`;
      const args = ['-X', 'POST', '-f', `name=${name}`, '-F', `private=${input.isPrivate}`];
      const description = input.description?.trim();
      if (description) args.push('-f', `description=${description}`);

      try {
        const repo = await ghApi<GithubApiRepo>(endpoint, args);
        return { ok: true, repo: toRepoInfo(repo) };
      } catch (error) {
        return { ok: false, error: ghErrorMessage(error) };
      }
    },
  );
}

/** Resolves a project to its repository, refusing a folder that is not in one. */
async function requireRepo(
  projectId: string,
): Promise<{ root: string; gitDir: string; folder: string }> {
  const folder = await getProjectPath(projectId);
  const repo = await locateRepo(folder);
  if (!repo) throw new Error('This project folder is not a git repository.');
  return { ...repo, folder };
}

/**
 * Runs a change the workspace panel asked for, then pushes the fresh state straight back so
 * the panel moves the instant git is done rather than when the file events arrive.
 */
async function workspaceGitOp(
  projectId: string,
  fn: (repo: { root: string; gitDir: string }) => Promise<string>,
): Promise<GitOpResult> {
  const resolved: { folder?: string } = {};
  const result = await runGitOp(async () => {
    const repo = await requireRepo(projectId);
    resolved.folder = repo.folder;
    return fn(repo);
  });
  if (resolved.folder) void refreshWorkspaceState(projectId, resolved.folder);
  return result;
}

function registerWorkspaceHandlers(): void {
  ipcMain.handle(
    IPC.git.workspaceState,
    async (_event, projectId: string): Promise<WorkspaceGitState> =>
      readWorkspaceGitState(await getProjectPath(projectId)),
  );

  ipcMain.handle(IPC.git.watchWorkingTree, async (event, projectId: string): Promise<void> => {
    watchWorkingTree(projectId, await getProjectPath(projectId), event.sender);
  });

  ipcMain.handle(IPC.git.unwatchWorkingTree, (event, projectId: string): void => {
    unwatchWorkingTree(projectId, event.sender);
  });

  ipcMain.handle(
    IPC.git.stage,
    (_event, projectId: string, paths: string[]): Promise<GitOpResult> =>
      workspaceGitOp(projectId, async ({ root }) => {
        await stagePaths(root, assertRepoPaths(root, paths));
        return 'Staged.';
      }),
  );

  ipcMain.handle(
    IPC.git.unstage,
    (_event, projectId: string, paths: string[]): Promise<GitOpResult> =>
      workspaceGitOp(projectId, async ({ root }) => {
        await unstagePaths(root, assertRepoPaths(root, paths));
        return 'Unstaged.';
      }),
  );

  ipcMain.handle(
    IPC.git.discard,
    async (
      _event,
      projectId: string,
      paths: string[],
      side: 'unstaged' | 'untracked',
    ): Promise<GitDiscardResult> => {
      let folder: string | null = null;
      try {
        const repo = await requireRepo(projectId);
        folder = repo.folder;
        if (side !== 'unstaged' && side !== 'untracked') throw new Error('Unknown change type.');
        const picked = assertRepoPaths(repo.root, paths);
        // Only throw away what the panel is actually showing as a change on that side, so a
        // stale or crafted request can never delete an unrelated file.
        const state = await readWorkspaceGitState(repo.root);
        const listed = new Set(
          (side === 'untracked' ? state.untracked : state.unstaged).map((e) => e.path),
        );
        const stray = picked.find((path) => !listed.has(path));
        if (stray) throw new Error(`${stray} has no changes to discard.`);
        return await discardPaths(repo.root, picked, side);
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      } finally {
        if (folder) void refreshWorkspaceState(projectId, folder);
      }
    },
  );

  ipcMain.handle(
    IPC.git.applyLines,
    async (_event, input: GitApplyLinesInput): Promise<GitDiscardResult> => {
      let folder: string | null = null;
      try {
        const repo = await requireRepo(input?.projectId);
        folder = repo.folder;
        const { side, action } = input;
        const fits =
          action === 'unstage'
            ? side === 'staged'
            : (action === 'stage' || action === 'discard') &&
              (side === 'unstaged' || side === 'untracked');
        if (!fits) throw new Error('That change cannot be made to those lines.');
        if (typeof input.originalId !== 'string' || typeof input.modifiedId !== 'string') {
          throw new Error('Unknown file version.');
        }
        const [path] = assertRepoPaths(repo.root, [input.path]);
        const [origPath] = input.origPath
          ? assertRepoPaths(repo.root, [input.origPath])
          : [undefined];
        return await applyLineChange(repo.root, {
          path,
          origPath,
          side,
          action,
          ranges: assertLineRanges(input.ranges),
          originalId: input.originalId,
          modifiedId: input.modifiedId,
        });
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      } finally {
        if (folder) void refreshWorkspaceState(input.projectId, folder);
      }
    },
  );

  ipcMain.handle(
    IPC.git.undoDiscard,
    (_event, projectId: string, token: string): Promise<GitOpResult> =>
      workspaceGitOp(projectId, async () => {
        await undoDiscard(token);
        return 'Restored.';
      }),
  );

  ipcMain.handle(
    IPC.git.resolveConflict,
    (_event, projectId: string, path: string, pick: 'ours' | 'theirs'): Promise<GitOpResult> =>
      workspaceGitOp(projectId, async ({ root }) => {
        if (pick !== 'ours' && pick !== 'theirs') throw new Error('Pick ours or theirs.');
        const [safe] = assertRepoPaths(root, [path]);
        await resolveConflict(root, safe, pick);
        return `Kept ${pick === 'ours' ? 'your' : 'their'} version of ${safe}.`;
      }),
  );

  ipcMain.handle(
    IPC.git.resolveConflictWithAi,
    async (
      _event,
      projectId: string,
      path: string,
      requestId?: string,
    ): Promise<ResolveConflictWithAiResult> => {
      let folder: string | null = null;
      try {
        const project = await getProject(projectId);
        const repo = await requireRepo(projectId);
        folder = repo.folder;
        const [safe] = assertRepoPaths(repo.root, [path]);
        const state = await readWorkspaceGitState(repo.root);
        const entry = state.conflicts.find((e) => e.path === safe);
        if (!entry) throw new Error(`${safe} is no longer in conflict.`);
        const before = await readConflictedText(repo.root, safe);
        if (before === null) {
          throw new Error(`${safe} is not a text file on disk. Keep ours or theirs instead.`);
        }
        if (!hasConflictMarkers(before)) {
          throw new Error(
            `${safe} has no conflict markers left. Review it and mark it as resolved, or keep one side.`,
          );
        }

        // The agent writes straight to disk, so the markers are kept to put back if it stops
        // half way, leaves some behind, or the user wants their own go at it after all.
        const undoToken = await backupPaths(repo.root, [safe]);
        const restore = (): Promise<void> => undoDiscard(undoToken).catch(() => undefined);
        const result = await runHeadlessCliPrompt(
          buildConflictResolutionPrompt(safe, state.operation, entry.conflict),
          repo.root,
          {
            requestId: typeof requestId === 'string' ? requestId : undefined,
            preferredCliId: project.cliId,
            allowWrites: true,
            timeoutMs: CONFLICT_RESOLVE_TIMEOUT_MS,
          },
        );
        const cli = result.cliName ?? 'The AI CLI';
        if (result.cancelled) {
          await restore();
          return { ok: false, cancelled: true, message: 'Stopped. The file is back as it was.' };
        }
        if (result.timedOut) {
          await restore();
          return { ok: false, message: `${result.error} The file is back as it was.` };
        }

        // What's on disk decides, not the exit code: a CLI can finish the edit and still
        // end without a closing answer.
        const after = await readConflictedText(repo.root, safe);
        if (after === null || hasConflictMarkers(after)) {
          await restore();
          const reason = !result.ok
            ? (result.error ?? `${cli} did not answer.`)
            : after === null
              ? `${cli} removed or broke the file.`
              : `${cli} left conflict markers in the file.`;
          return { ok: false, message: `${reason} The file is back as it was.` };
        }
        return {
          ok: true,
          message: `${cli} resolved ${safe}. Review it, then mark it as resolved.`,
          summary: result.ok ? resolutionSummary(result.text) : undefined,
          undoToken,
        };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      } finally {
        if (folder) void refreshWorkspaceState(projectId, folder);
      }
    },
  );

  ipcMain.handle(IPC.git.cancelResolveConflictWithAi, (_event, requestId: string): boolean => {
    return cancelHeadlessPrompt(requestId);
  });

  ipcMain.handle(
    IPC.git.abortOperation,
    (_event, projectId: string): Promise<GitOpResult> =>
      workspaceGitOp(projectId, ({ root, gitDir }) => abortOperation(root, gitDir)),
  );

  ipcMain.handle(
    IPC.git.commitStaged,
    async (_event, projectId: string, message: string, push: boolean): Promise<GitOpResult> => {
      if (!message?.trim()) return { ok: false, message: 'Write a commit message first.' };
      const result = await workspaceGitOp(projectId, async ({ root }) => {
        const out = await commitStaged(root, message.trim());
        if (!push) return out;
        const branch = await currentBranch(root);
        if (!branch) throw new Error('Committed, but there is no branch to push.');
        await pushCurrentBranch(root, branch);
        return `${out}\nPushed ${branch}.`;
      });
      if (result.ok && push) schedulePipelineCheck(projectId);
      return result;
    },
  );

  ipcMain.handle(
    IPC.git.stashPush,
    (_event, input: GitStashPushInput): Promise<GitOpResult> =>
      workspaceGitOp(input?.projectId, async ({ root }) => {
        if (input?.keepIndex && input?.includeUntracked) {
          throw new Error(
            'A stash cannot keep staged changes and include untracked files at once.',
          );
        }
        return stashPush(root, {
          includeUntracked: Boolean(input?.includeUntracked),
          keepIndex: Boolean(input?.keepIndex),
          message: typeof input?.message === 'string' ? input.message : undefined,
        });
      }),
  );

  ipcMain.handle(IPC.git.stashList, async (_event, projectId: string): Promise<GitStashEntry[]> => {
    const { root } = await requireRepo(projectId);
    return listStashes(root);
  });

  ipcMain.handle(
    IPC.git.stashPop,
    (_event, projectId: string, ref?: string): Promise<GitOpResult> =>
      workspaceGitOp(projectId, async ({ root }) => {
        const stashes = await listStashes(root);
        const target = typeof ref === 'string' && ref ? ref : stashes[0]?.ref;
        if (!target) throw new Error('There is no stash to pop.');
        return stashRestore(root, target, 'pop');
      }),
  );

  ipcMain.handle(
    IPC.git.stashApply,
    (_event, projectId: string, ref?: string): Promise<GitOpResult> =>
      workspaceGitOp(projectId, async ({ root }) => {
        const stashes = await listStashes(root);
        const target = typeof ref === 'string' && ref ? ref : stashes[0]?.ref;
        if (!target) throw new Error('There is no stash to apply.');
        return stashRestore(root, target, 'apply');
      }),
  );

  ipcMain.handle(
    IPC.git.stashDrop,
    (_event, projectId: string, ref: string): Promise<GitOpResult> =>
      workspaceGitOp(projectId, async ({ root }) => stashDrop(root, ref)),
  );

  ipcMain.handle(
    IPC.git.fileDiff,
    async (
      _event,
      projectId: string,
      path: string,
      side: GitDiffSide,
      origPath?: string,
    ): Promise<GitFileDiff> => {
      const { root } = await requireRepo(projectId);
      const [safe] = assertRepoPaths(root, [path]);
      const [safeOrig] = origPath ? assertRepoPaths(root, [origPath]) : [undefined];
      return readFileDiff(root, safe, side, safeOrig);
    },
  );

  ipcMain.handle(
    IPC.git.fileImage,
    async (
      _event,
      projectId: string,
      path: string,
      side: GitDiffSide,
      origPath?: string,
    ): Promise<GitImageDiff> => {
      const { root } = await requireRepo(projectId);
      const [safe] = assertRepoPaths(root, [path]);
      const [safeOrig] = origPath ? assertRepoPaths(root, [origPath]) : [undefined];
      return readFileImageDiff(root, safe, side, safeOrig);
    },
  );

  ipcMain.handle(
    IPC.git.writeWorkingFile,
    async (_event, projectId: string, path: string, content: string): Promise<void> => {
      if (typeof content !== 'string') throw new Error('Nothing to save.');
      const { root } = await requireRepo(projectId);
      const [safe] = assertRepoPaths(root, [path]);
      await writeWorkingFile(root, safe, content);
    },
  );

  ipcMain.handle(
    IPC.git.commitFiles,
    async (_event, projectId: string, hash: string): Promise<GitChangeEntry[]> => {
      const { root } = await requireRepo(projectId);
      return readCommitFiles(root, assertCommitHash(hash));
    },
  );

  ipcMain.handle(
    IPC.git.commitFileImage,
    async (
      _event,
      projectId: string,
      hash: string,
      path: string,
      origPath?: string,
    ): Promise<GitImageDiff> => {
      const { root } = await requireRepo(projectId);
      const [safe] = assertRepoPaths(root, [path]);
      const [safeOrig] = origPath ? assertRepoPaths(root, [origPath]) : [undefined];
      return readCommitFileImageDiff(root, assertCommitHash(hash), safe, safeOrig);
    },
  );

  ipcMain.handle(
    IPC.git.commitFileDiff,
    async (
      _event,
      projectId: string,
      hash: string,
      path: string,
      origPath?: string,
    ): Promise<GitFileDiff> => {
      const { root } = await requireRepo(projectId);
      const [safe] = assertRepoPaths(root, [path]);
      const [safeOrig] = origPath ? assertRepoPaths(root, [origPath]) : [undefined];
      return readCommitFileDiff(root, assertCommitHash(hash), safe, safeOrig);
    },
  );
}

export function registerGitHandlers(): void {
  registerRepoHandlers();
  registerBranchHandlers();
  registerTagHandlers();
  registerGithubHandlers();
  registerWorkspaceHandlers();
}
