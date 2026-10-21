import { quoteForShell } from '@agentmat/core';
import { CHECKSUM_MISMATCH_EXIT } from './installPlan';

/**
 * Letting the server fetch the server core itself. The release is public, so a server that can
 * reach GitHub and has curl or wget saves the app from pushing tens of megabytes over SSH from
 * a home connection. These are the login user's commands, as data: a probe for the preflight and
 * the download for the installer. Both only ever name a GitHub release asset of the right shape.
 *
 * The download lands in the same staging folder an upload would, and the install's root step
 * checks it again from a folder only root can write to, so a server-side download is trusted no
 * more than an upload is.
 */

export type DownloadTool = 'curl' | 'wget';

const RELEASE_URL =
  /^https:\/\/github\.com\/[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+\/releases\/download\/v[0-9A-Za-z][0-9A-Za-z.+-]{0,63}\/(agentmate-core-[0-9A-Za-z.+-]+-linux-(?:x64|arm64)\.tar\.gz)$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * How long the probe waits on GitHub before the app sends the core itself. A slow link can take
 * ten seconds to answer a HEAD through GitHub's redirect, so curl is given 25 and wget's own
 * timeouts add up to about the same; the SSH command's limit sits above both.
 */
export const RELEASE_PROBE_TIMEOUT_MS = 60_000;
/** curl gives up on a download after this long; the SSH command's own limit sits just above. */
const DOWNLOAD_MAX_SECONDS = 600;
export const DOWNLOAD_TIMEOUT_MS = (DOWNLOAD_MAX_SECONDS + 30) * 1_000;

const q = (value: string): string => quoteForShell(value, 'posix');

function assertReleaseUrl(url: string, file?: string): void {
  const match = RELEASE_URL.exec(url);
  if (!match) throw new Error(`${url} is not a server core release address.`);
  if (file !== undefined && match[1] !== file) {
    throw new Error(`${url} does not point at ${file}.`);
  }
}

/**
 * Asks the server whether it can reach the release: prints `curl` or `wget` for the first one
 * that gets an answer, and nothing otherwise. A HEAD request through GitHub's redirect, so it
 * also notices a release that is not published, without downloading any of it.
 */
export function probeCommand(url: string): string {
  assertReleaseUrl(url);
  const target = q(url);
  const script = [
    `{ command -v curl >/dev/null 2>&1 && curl -fsSIL --connect-timeout 8 --max-time 25 -o /dev/null ${target} >/dev/null 2>&1 && echo curl; }`,
    `{ command -v wget >/dev/null 2>&1 && wget -q --spider --tries=1 --timeout=10 ${target} >/dev/null 2>&1 && echo wget; }`,
  ].join(' || ');
  return `sh -c ${q(script)}`;
}

/** The tool the probe printed, or null when the server cannot fetch the release. */
export function parseProbe(stdout: string): DownloadTool | null {
  const answer = stdout.trim().split('\n').at(-1)?.trim();
  return answer === 'curl' || answer === 'wget' ? answer : null;
}

export interface DownloadInput {
  tool: DownloadTool;
  url: string;
  /** A folder the login user owns, such as the staging folder an upload would use. */
  directory: string;
  /** The tarball's file name; it is saved as `<directory>/<file>`. */
  file: string;
  sha256: string;
}

/**
 * Downloads the release into `directory` and checks it against its published checksum, as the
 * login user. A download that fails or does not match leaves nothing behind, and a mismatch
 * exits with `CHECKSUM_MISMATCH_EXIT` so it reads differently from a network error.
 */
export function downloadCommand(input: DownloadInput): string {
  assertReleaseUrl(input.url, input.file);
  if (!SHA256.test(input.sha256)) throw new Error('The release checksum is not a SHA-256.');
  const destination = q(`${input.directory}/${input.file}`);
  const url = q(input.url);
  const fetch =
    input.tool === 'curl'
      ? `curl -fsSL --retry 2 --connect-timeout 15 --max-time ${DOWNLOAD_MAX_SECONDS} -o ${destination} ${url}`
      : `wget -q --tries=3 --timeout=30 -O ${destination} ${url}`;
  const script = [
    'umask 077',
    `${fetch} && cd ${q(input.directory)} && { printf '%s  %s\\n' ${input.sha256} ${q(input.file)} | sha256sum -c --status || (exit ${CHECKSUM_MISMATCH_EXIT}); }`,
    'code=$?',
    `[ "$code" -eq 0 ] || rm -f -- ${destination}`,
    'exit "$code"',
  ].join('; ');
  return `sh -c ${q(script)}`;
}
