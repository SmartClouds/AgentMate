import type { SupportedOS } from '../cli/registry.js';

/**
 * CodeQL is the one scanner with no package manager behind it on most platforms: Homebrew has a
 * cask for macOS, but there is no winget, chocolatey or apt package, so the documented install is
 * "download a zip and put it on your PATH". That is a poor thing to ask of someone who just wants
 * to scan a project, so Runova can fetch and unpack it into its own tools folder instead, the
 * same place LanguageTool lives.
 *
 * Nothing here touches the filesystem or the network; it only works out the names and URLs, so the
 * main process and the renderer can agree on them.
 */

export const CODEQL_TOOL_ID = 'codeql';
export const CODEQL_REPO = 'github/codeql-cli-binaries';
export const CODEQL_LATEST_RELEASE_API = `https://api.github.com/repos/${CODEQL_REPO}/releases/latest`;

/** The folder the zip unpacks into, and the folder Runova keeps it in. */
export const CODEQL_INSTALL_DIRNAME = 'codeql';

/**
 * Per-platform release asset. The repo also publishes an all-platforms `codeql.zip`, which is
 * roughly four times the size for no benefit here.
 */
export function codeqlAssetName(platform: SupportedOS): string {
  switch (platform) {
    case 'win32':
      return 'codeql-win64.zip';
    case 'darwin':
      return 'codeql-osx64.zip';
    default:
      return 'codeql-linux64.zip';
  }
}

/** Each asset ships a sibling `<name>.checksum.txt` holding "<sha256>  <filename>". */
export function codeqlChecksumAssetName(platform: SupportedOS): string {
  return `${codeqlAssetName(platform)}.checksum.txt`;
}

export function codeqlBinaryName(platform: SupportedOS): string {
  return platform === 'win32' ? 'codeql.exe' : 'codeql';
}

export function codeqlDownloadUrl(tag: string, platform: SupportedOS): string {
  return `https://github.com/${CODEQL_REPO}/releases/download/${tag}/${codeqlAssetName(platform)}`;
}

export function codeqlChecksumUrl(tag: string, platform: SupportedOS): string {
  return `https://github.com/${CODEQL_REPO}/releases/download/${tag}/${codeqlChecksumAssetName(platform)}`;
}

/** Parses "7066f60b…  codeql-win64.zip" down to just the digest. */
export function parseChecksumFile(text: string): string | null {
  const match = /\b([0-9a-f]{64})\b/i.exec(text);
  return match ? match[1].toLowerCase() : null;
}

export type CodeqlInstallPhase =
  | 'idle'
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface CodeqlInstallProgress {
  phase: CodeqlInstallPhase;
  /** Human-readable status for the card, e.g. "Downloading CodeQL 2.26.4". */
  message: string;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  /** 0 to 1 where it can be known, otherwise null so the bar can go indeterminate. */
  fraction: number | null;
}

export interface CodeqlLocalStatus {
  /** True when a managed copy is unpacked in Runova's tools folder. */
  installed: boolean;
  /** Absolute path to the managed binary, or null. */
  path: string | null;
  version: string | null;
  /** True when a `codeql` on PATH is being used instead of the managed copy. */
  onPath: boolean;
  /** Where a managed install would go, so the card can offer to open it. */
  installDir: string;
  /** Set while an install is in flight, so reopening the page rejoins it. */
  progress: CodeqlInstallProgress | null;
}
