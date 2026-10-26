import type { ProjectWordPressItemKind, WpItemRef, WpRollbackReason } from '@runova/core';
import { WP_AGENT_PREFIXES, WP_HARD_DENY_DIRS, WP_HARD_DENY_FILES } from '@runova/core';
import type {
  DeployWordPressDeployResult,
  DeployWordPressLeftOutReason,
  DeployWordPressOperationKind,
  DeployWordPressPhase,
  DeployWordPressWarning,
} from '@shared/deployWordPressTypes';
import type { WordPressErrorCode } from '@shared/wordpressErrors';

/**
 * The words the WordPress project screens use (E21): what each phase, reason, warning and
 * outcome means, said plainly. Kept in one place so the dialogs and their tests agree.
 */

export const ITEM_KIND_LABEL: Record<ProjectWordPressItemKind, string> = {
  theme: 'Theme',
  plugin: 'Plugin',
  'mu-plugin': 'Must-use plugin',
};

export const ITEM_KIND_GROUP_LABEL: Record<ProjectWordPressItemKind, string> = {
  theme: 'Themes',
  plugin: 'Plugins',
  'mu-plugin': 'Must-use plugins',
};

export const ITEM_KIND_ORDER: readonly ProjectWordPressItemKind[] = [
  'theme',
  'plugin',
  'mu-plugin',
];

export function itemLabel(item: WpItemRef): string {
  return `${ITEM_KIND_LABEL[item.kind]} ${item.slug}`;
}

/** A folder name for a project: lowercase, dashes for anything else, never empty. */
export function slugifyProjectName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'wordpress-site';
}

/** Joins a folder and a name with the separator the folder already uses. */
export function joinFolder(root: string, name: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  return `${trimmed}${separator}${name}`;
}

export const PHASE_LABEL: Record<DeployWordPressPhase, string> = {
  connecting: 'Reaching the site',
  manifest: "Listing the site's files",
  hashing: 'Checking the files on this computer',
  download: 'Downloading files',
  write: 'Writing files into the project folder',
  upload: 'Uploading the changes',
  validate: 'Checking the PHP files for syntax errors',
  apply: 'Putting the new files in place',
  verify: 'Checking the site still loads',
  finalize: 'Finishing up',
  rollback: 'Putting the old files back',
  done: 'Done',
  failed: 'Stopped',
};

/** The order phases happen in, so a timeline can place one it did not plan for. */
export const PHASE_ORDER: readonly DeployWordPressPhase[] = [
  'connecting',
  'manifest',
  'hashing',
  'download',
  'write',
  'upload',
  'validate',
  'apply',
  'verify',
  'finalize',
  'rollback',
];

export const PLANNED_PHASES: Record<DeployWordPressOperationKind, DeployWordPressPhase[]> = {
  deploy: ['connecting', 'hashing', 'upload', 'validate', 'apply', 'verify', 'finalize'],
  pull: ['connecting', 'manifest', 'download', 'write'],
  createProject: ['connecting', 'manifest', 'download', 'write'],
  items: ['connecting', 'manifest', 'download', 'write'],
  rollback: ['connecting', 'rollback'],
};

export const LEFT_OUT_REASON: Record<DeployWordPressLeftOutReason, string> = {
  agentFiles: "Agent settings or Runova's own files",
  hardDenied: 'Never sent: version control, secrets, PHP settings or system clutter',
  ignored:
    'Left out by an ignore rule (your ignore list, .gitignore, .distignore, .runovaignore or the defaults)',
  symlink: 'A link to somewhere else, which is never followed',
  tooLarge: 'Larger than 64 MB',
  caseCollision: 'Another file has the same name apart from upper and lower case',
  notUtf8: "The file name isn't valid text",
  pathRejected: "A name a WordPress site can't safely hold",
};

/** Agent and Runova folders on the hard deny list; the rest of it is version control. */
const VCS_DIRS = new Set(['.github', '.git', '.svn', '.hg', '.worktrees']);
const AGENT_DIRS = new Set(WP_HARD_DENY_DIRS.filter((dir) => !VCS_DIRS.has(dir)));
const AGENT_FILES = new Set(
  WP_HARD_DENY_FILES.filter(
    (name) =>
      name.endsWith('.md') ||
      name === '.mcp.json' ||
      name === 'opencode.json' ||
      name === '.cursorrules' ||
      name === '.windsurfrules' ||
      name === '.roomodes' ||
      name === '.runovaignore',
  ),
);
const AGENT_PREFIXES = WP_AGENT_PREFIXES;

/** Whether a path is (or sits inside) an agent's settings, skills or Runova's own files. */
export function isAgentPath(path: string): boolean {
  return path.split('/').some((segment) => {
    const name = segment.toLowerCase();
    return (
      AGENT_DIRS.has(name) ||
      AGENT_FILES.has(name) ||
      AGENT_PREFIXES.some((prefix) => name.startsWith(prefix))
    );
  });
}

export interface WarningCopy {
  title: string;
  detail: string;
}

export const WARNING_COPY: Record<DeployWordPressWarning, WarningCopy> = {
  touchesActiveThemeCore: {
    title: "Changes the active theme's core files",
    detail:
      'Files like style.css or functions.php of the theme the site uses right now are part of this deploy. A mistake there shows on every page.',
  },
  deletesActivePluginMainFile: {
    title: "Deletes an active plugin's main file",
    detail: 'WordPress switches a plugin off when its main file goes missing.',
  },
  createsItem: {
    title: 'Adds a new theme or plugin folder to the site',
    detail: "It won't be switched on. Activate it in wp-admin when you're ready.",
  },
  noRescueGuard: {
    title: "The site's safety guard isn't installed",
    detail:
      'If a change breaks the site badly, it may not be able to put the old files back on its own. Reinstall the Runova Connector to bring the guard back.',
  },
  healthCheckUnavailable: {
    title: "The site can't check itself after the change",
    detail:
      'The host blocks the requests a site makes to itself, so a broken page may go unnoticed. Open the site yourself once this is done.',
  },
  plainHttp: {
    title: 'This site is reached over plain HTTP',
    detail:
      'Every call is signed, so nobody can change the files on the way, but anyone on the network can read them.',
  },
  readOnlyScope: {
    title: "This site's key is read-only",
    detail:
      'Runova can pull from this site but not deploy to it. Make a read-write key in wp-admin and connect the site again to deploy.',
  },
  lineEndingsOnly: {
    title: 'Some files differ only in line endings',
    detail: "They're sent exactly as they are on this computer.",
  },
};

/** Warnings the site refuses unless the deploy is forced. */
export const FORCEABLE_WARNINGS: ReadonlySet<DeployWordPressWarning> = new Set([
  'touchesActiveThemeCore',
  'deletesActivePluginMainFile',
]);

export const ROLLBACK_REASON: Record<WpRollbackReason, string> = {
  healthCheck: 'The site showed an error after the change, so the old files were put back.',
  fatalError:
    'A changed file caused a PHP fatal error on the site, so the old files were put back.',
  notConfirmed:
    "The site didn't hear back from Runova in time to keep the change, so it put the old files back on its own.",
  interrupted: 'The deploy was cut off before it finished, so the old files were put back.',
  requested: 'The deploy was stopped, so the old files were put back.',
};

export interface OutcomeCopy {
  tone: 'success' | 'warning' | 'error';
  title: string;
  detail: string;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function deployOutcome(result: DeployWordPressDeployResult): OutcomeCopy {
  switch (result.state) {
    case 'done':
      return {
        tone: 'success',
        title: 'Deployed',
        detail: `${count(result.uploaded, 'file', 'files')} uploaded, ${count(result.deleted, 'file', 'files')} deleted. The site is running the new files.`,
      };
    case 'rolledBack':
      return {
        tone: 'warning',
        title: 'Rolled back',
        detail: result.reason
          ? ROLLBACK_REASON[result.reason]
          : 'The old files were put back, so the site is as it was before.',
      };
    case 'aborted':
      return {
        tone: 'warning',
        title: 'Stopped',
        detail: 'The deploy stopped before anything changed on the site.',
      };
    case 'expired':
      return {
        tone: 'warning',
        title: 'Expired',
        detail: 'The deploy sat waiting too long and expired. Nothing changed on the site.',
      };
    default:
      return {
        tone: 'error',
        title: "The deploy didn't finish",
        detail:
          "Runova lost track of it partway. Open the site's Deploys in Deploy to see where it stands.",
      };
  }
}

/** What to do next for the errors that have an obvious next step. */
export function errorHint(code: WordPressErrorCode | null): string | null {
  switch (code) {
    case 'planExpired':
    case 'localChanged':
    case 'conflict':
      return 'Check the changes again to get a fresh review.';
    case 'vaultLocked':
      return 'Unlock the Servers vault in Deploy, then try again.';
    case 'operationBusy':
    case 'busy':
      return 'Another pull or deploy for this site is still running. Try again when it ends.';
    case 'readOnly':
      return 'This key is read-only. Make a read-write key in wp-admin and connect the site again.';
    case 'folderNotEmpty':
      return 'Pick an empty folder, or a new one.';
    case 'siteUnknown':
      return 'Connect the site again in Deploy.';
    case 'syntaxError':
      return 'Fix the lines below and check the changes again. Nothing on the site was changed.';
    default:
      return null;
  }
}

/**
 * Whether a plan has run out. Plans are made in the main process and carry milliseconds; a value
 * small enough to be seconds is read as seconds, so a unit slip can never bounce every deploy.
 */
export function planExpired(expiresAt: number, now = Date.now()): boolean {
  const ms = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  return ms <= now;
}

/** Errors that a fresh plan fixes. */
export function needsNewPlan(code: WordPressErrorCode | null): boolean {
  return code === 'planExpired' || code === 'localChanged' || code === 'conflict';
}

export interface FileLineIssue {
  path: string;
  line: number;
  message: string;
}

/**
 * The file and line lines of a syntax error message: a summary first, then
 * `<path>:<line>: <message>` per error. Anything else in the message stays plain text.
 */
export function parseSyntaxErrors(message: string): { summary: string; issues: FileLineIssue[] } {
  const issues: FileLineIssue[] = [];
  const rest: string[] = [];
  for (const raw of message.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(.+?):(\d+):\s*(.+)$/);
    if (match) issues.push({ path: match[1], line: Number(match[2]), message: match[3] });
    else rest.push(line);
  }
  return { summary: rest.join(' '), issues };
}
