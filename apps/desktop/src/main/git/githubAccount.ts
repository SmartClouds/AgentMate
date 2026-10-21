import type {
  GithubAccount,
  GithubActivity,
  GithubNotificationItem,
  GithubNotifications,
  GithubOwner,
  GithubRepoInfo,
  GitOpResult,
} from '../../shared/apiTypes';
import { ghApi, ghApiAllowEmpty, ghErrorMessage, ghGraphql, isGhCliAvailable } from './githubCli';
import { ACTIVITY_DAYS, recentDays } from './plumbing';

/** What GitHub accepts for a login or a repository name. */
export const GITHUB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface GithubApiRepo {
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string | null;
  private: boolean;
}

export function toRepoInfo(repo: GithubApiRepo): GithubRepoInfo {
  return {
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    cloneUrl: repo.clone_url,
    sshUrl: repo.ssh_url,
    // A repository with no commits yet reports no default branch.
    defaultBranch: repo.default_branch ?? '',
    isPrivate: repo.private,
  };
}

/**
 * Turns a failed gh call into the two things every caller here needs: whether the
 * failure was "you are not signed in" rather than something else, and the message
 * to show for it.
 */
function classifyGhError(error: unknown): { authenticated: boolean; message: string } {
  const message = ghErrorMessage(error);
  const signedOut = /401|not logged|must authenticate|gh auth login/i.test(message);
  return {
    authenticated: !signedOut,
    message: signedOut
      ? `Not signed in to the GitHub CLI. Run "gh auth login" first. (${message})`
      : message,
  };
}

/** Who the GitHub CLI is logged in as, and everywhere that account can publish a repo. */
export async function readGithubAccount(): Promise<GithubAccount> {
  if (!(await isGhCliAvailable())) {
    return { cliAvailable: false, authenticated: false, login: null, owners: [] };
  }

  let login: string;
  let name: string | null;
  try {
    const user = await ghApi<{ login: string; name?: string | null }>('user');
    login = user.login;
    name = user.name?.trim() || null;
  } catch (error) {
    return {
      cliAvailable: true,
      authenticated: false,
      login: null,
      owners: [],
      error: ghErrorMessage(error),
      // Anything but a sign-out is a hiccup, and callers that poll must not read it as one.
      checkFailed: classifyGhError(error).authenticated,
    };
  }

  const owners: GithubOwner[] = [{ login, type: 'user' }];
  try {
    const orgs = await ghApi<{ login: string }[]>('user/orgs?per_page=100');
    for (const org of orgs) owners.push({ login: org.login, type: 'organization' });
  } catch {
    // Listing organizations needs the read:org scope, which plenty of tokens don't carry.
    // The personal account on its own is still a perfectly good place to publish to.
  }

  return { cliAvailable: true, authenticated: true, login, name, owners };
}

interface GithubContributionCalendar {
  viewer: {
    login: string;
    contributionsCollection: {
      contributionCalendar: {
        totalContributions: number;
        weeks: { contributionDays: { date: string; contributionCount: number }[] }[];
      };
    };
  } | null;
}

function emptyGithubActivity(partial: Omit<GithubActivity, 'yearCount' | 'days'>): GithubActivity {
  return { ...partial, yearCount: 0, days: [] };
}

/** Contribution calendar for the GitHub CLI's signed-in user. */
export async function readGithubActivity(): Promise<GithubActivity> {
  if (!(await isGhCliAvailable())) {
    return emptyGithubActivity({
      ok: false,
      cliAvailable: false,
      authenticated: false,
      login: null,
      error: 'GitHub CLI (gh) is not installed.',
    });
  }

  try {
    const data = await ghGraphql<GithubContributionCalendar>(
      'query{viewer{login contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}',
    );
    const viewer = data.viewer;
    if (!viewer) {
      return emptyGithubActivity({
        ok: false,
        cliAvailable: true,
        authenticated: false,
        login: null,
        error: 'Not signed in to the GitHub CLI. Run "gh auth login" first.',
      });
    }

    const byDate = new Map<string, number>();
    for (const week of viewer.contributionsCollection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) {
        byDate.set(day.date, day.contributionCount);
      }
    }

    return {
      ok: true,
      cliAvailable: true,
      authenticated: true,
      login: viewer.login,
      yearCount: viewer.contributionsCollection.contributionCalendar.totalContributions,
      days: recentDays(byDate, ACTIVITY_DAYS),
    };
  } catch (error) {
    const { authenticated, message } = classifyGhError(error);
    return emptyGithubActivity({
      ok: false,
      cliAvailable: true,
      authenticated,
      login: null,
      error: message,
    });
  }
}

interface GithubApiNotification {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  subject: { title: string; url: string | null; type: string };
  repository: { full_name: string; html_url: string };
}

function notificationUrl(item: GithubApiNotification): string | null {
  const apiUrl = item.subject.url;
  if (!apiUrl) return item.repository.html_url || null;
  return apiUrl
    .replace('https://api.github.com/repos/', 'https://github.com/')
    .replace('/pulls/', '/pull/')
    .replace('/commits/', '/commit/');
}

function toNotificationItem(item: GithubApiNotification): GithubNotificationItem {
  return {
    id: item.id,
    unread: item.unread,
    reason: item.reason,
    title: item.subject.title,
    type: item.subject.type,
    repo: item.repository.full_name,
    updatedAt: item.updated_at,
    url: notificationUrl(item),
  };
}

function emptyGithubNotifications(
  partial: Omit<GithubNotifications, 'notifications'>,
): GithubNotifications {
  return { ...partial, notifications: [] };
}

export async function readGithubNotifications(): Promise<GithubNotifications> {
  if (!(await isGhCliAvailable())) {
    return emptyGithubNotifications({
      ok: false,
      cliAvailable: false,
      authenticated: false,
      error: 'GitHub CLI (gh) is not installed.',
    });
  }

  try {
    const items = await ghApi<GithubApiNotification[]>('notifications?per_page=50');
    return {
      ok: true,
      cliAvailable: true,
      authenticated: true,
      notifications: items.map(toNotificationItem),
    };
  } catch (error) {
    const { authenticated, message } = classifyGhError(error);
    return emptyGithubNotifications({
      ok: false,
      cliAvailable: true,
      authenticated,
      error: message,
    });
  }
}

const GITHUB_THREAD_ID_PATTERN = /^\d+$/;

export async function markGithubNotificationRead(threadId: string): Promise<GitOpResult> {
  const id = threadId.trim();
  if (!GITHUB_THREAD_ID_PATTERN.test(id)) {
    return { ok: false, message: 'That notification id is not valid.' };
  }
  if (!(await isGhCliAvailable())) {
    return { ok: false, message: 'GitHub CLI (gh) is not installed.' };
  }
  try {
    await ghApiAllowEmpty(`notifications/threads/${id}`, ['-X', 'PATCH']);
    return { ok: true, message: 'Marked as read.' };
  } catch (error) {
    return { ok: false, message: ghErrorMessage(error) };
  }
}

export async function markGithubNotificationsRead(): Promise<GitOpResult> {
  if (!(await isGhCliAvailable())) {
    return { ok: false, message: 'GitHub CLI (gh) is not installed.' };
  }
  try {
    await ghApiAllowEmpty('notifications', ['-X', 'PUT']);
    return { ok: true, message: 'All notifications marked as read.' };
  } catch (error) {
    return { ok: false, message: ghErrorMessage(error) };
  }
}
