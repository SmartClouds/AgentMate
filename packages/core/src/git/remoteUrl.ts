/**
 * The same address with any embedded userinfo removed.
 *
 * A remote cloned with a token is stored verbatim as
 * `https://user:ghp_xxx@github.com/org/repo.git`, so anywhere that address is
 * shown, saved or opened in a browser would carry the token with it. The
 * scp-style `git@host:owner/repo` form has no password field, so it is left alone.
 */
export function stripRemoteCredentials(address: string): string {
  const url = address.trim();
  const match = /^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@(.*)$/i.exec(url);
  return match ? `${match[1]}${match[2]}` : url;
}

/**
 * Turns any way of writing a repository address into a link a browser can open,
 * which is all a project's stored `repoUrl` is ever used for.
 *
 * Handles the three forms people arrive with: an ssh remote (`ssh://git@host/owner/repo`
 * or the scp-style `git@host:owner/repo.git`), a full http(s) URL, and a bare
 * `host/owner/repo` someone copied out of the address bar. The trailing `.git` goes
 * either way, and an address in some other scheme is left exactly as it was typed.
 * Credentials embedded in the remote never survive into the link.
 */
export function browsableRepoUrl(address: string): string {
  const url = stripRemoteCredentials(address.trim().replace(/\.git$/i, ''));
  if (!url) return '';

  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;

  // scp-style, e.g. git@github.com:me/my-app
  const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2]}`;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  return `https://${url}`;
}

/** True for github.com, with or without the www a browser address bar may show. */
function isGithubHost(host: string): boolean {
  return /^(www\.)?github\.com$/i.test(host);
}

/**
 * `owner/repo` from the path part of a GitHub address, or null without both. Anything after
 * the repo is dropped, so a link copied from a file or branch page (`owner/repo/tree/main`)
 * still clones the repo instead of handing git an address it can't use.
 */
function githubRepoPath(path: string): string | null {
  const segments = path
    .replace(/[?#].*$/, '')
    .split('/')
    .filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/**
 * Clone scope: GitHub repos only. Accepts the forms users paste (https URL with or without
 * .git, bare host/owner/repo, scp-style git@github.com:owner/repo,
 * ssh://git@github.com/owner/repo, or a browser link deeper into the repo), and rejects local
 * paths, file:// URLs and non-GitHub hosts so a project never clones from an unexpected place.
 * Returns the https address to clone, or null when the address is not clonable.
 */
export function normalizeCloneUrl(address: string): string | null {
  const raw = stripRemoteCredentials(address.trim().replace(/\.git$/i, ''));
  if (!raw || /\s/.test(raw)) return null;
  if (/^([a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|file:)/i.test(raw)) return null;

  // scp-style: git@github.com:owner/repo (optionally user@host)
  const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(raw);
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(raw);
  const https = /^https?:\/\/([^/]+)\/(.+)$/i.exec(raw);
  // bare host/owner/repo copied from the address bar
  const bare = /^((?:www\.)?github\.com)\/(.+)$/i.exec(raw);
  const match = scp ?? ssh ?? https ?? bare;
  if (!match) return null;
  const [, host, path] = match;
  if (!isGithubHost(host)) return null;

  const repoPath = githubRepoPath(path);
  return repoPath ? `https://github.com/${repoPath}` : null;
}

/** True when the address is one a project can clone. */
export function isClonableGithubUrl(address: string): boolean {
  return normalizeCloneUrl(address) !== null;
}
