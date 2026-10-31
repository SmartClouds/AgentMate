import type { CliDefinition } from './registry.js';

export interface HeadlessImageInput {
  /** Added after the rest of the headless args. */
  args: string[];
  /** Goes in front of the prompt text. */
  promptPrefix: string;
  /** Merged into the CLI's environment. */
  env: Record<string, string>;
}

/** True when a headless run of this CLI can be shown a screenshot. */
export function supportsPromptImages(cli: CliDefinition): boolean {
  return !!cli.promptCommand && !!cli.promptImageInput;
}

function mention(cli: CliDefinition, path: string): string {
  const slashed = path.replace(/\\/g, '/');
  const quoted = /\s/.test(slashed) ? `"${slashed}"` : slashed;
  return (cli.fileMention ?? 'at') === 'at' ? `@${quoted}` : quoted;
}

/** A Windows drive or UNC path (`C:\x`, `C:/x`, `\\host\x`) or a POSIX one (`/x`). */
function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\');
}

/** The folder a path sits in, with forward slashes. */
function folderOf(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  const cut = slashed.lastIndexOf('/');
  return cut <= 0 ? slashed : slashed.slice(0, cut);
}

export interface HeadlessImageOptions {
  /**
   * True (the default) tells a `read-tool` CLI to open the images and use its tools for nothing
   * else, which suits a run that only needs to look. A run that also works in a project passes
   * false so the CLI can still read the code.
   */
  lookOnly?: boolean;
}

/**
 * What a headless run needs to attach `imagePaths`, in the way this CLI takes images. A path is
 * relative to the run's cwd, or absolute, in which case its folder is opened up to CLIs that only
 * read inside their workspace (`promptImageDirFlag`). Empty for no images or a CLI that can't take
 * them, so a caller can always apply it.
 */
export function buildHeadlessImageInput(
  cli: CliDefinition,
  imagePaths: string[],
  options: HeadlessImageOptions = {},
): HeadlessImageInput {
  if (imagePaths.length === 0 || !supportsPromptImages(cli)) {
    return { args: [], promptPrefix: '', env: {} };
  }
  const env = { ...cli.promptImageEnv };
  const dirFlag = cli.promptImageDirFlag;
  const folders = dirFlag
    ? [...new Set(imagePaths.filter(isAbsolutePath).map(folderOf))].flatMap((dir) => [dirFlag, dir])
    : [];
  const extra = [...(cli.promptImageArgs ?? []), ...folders];
  switch (cli.promptImageInput) {
    case 'flag': {
      const flag = cli.promptImageFlag;
      return {
        args: [...extra, ...imagePaths.flatMap((path) => (flag ? [flag, path] : [path]))],
        promptPrefix: '',
        env,
      };
    }
    case 'mention':
      return {
        args: extra,
        promptPrefix: `${imagePaths.map((path) => mention(cli, path)).join(' ')} `,
        env,
      };
    default: {
      const files = imagePaths
        .map((path) => {
          const slashed = path.replace(/\\/g, '/');
          return isAbsolutePath(path) ? slashed : `./${slashed}`;
        })
        .join(', ');
      const only =
        options.lookOnly === false ? '' : ' Do not read or do anything else with your tools.';
      return {
        args: extra,
        promptPrefix: `Before anything else, use the Read tool to look at ${files}.${only}\n\n`,
        env,
      };
    }
  }
}
