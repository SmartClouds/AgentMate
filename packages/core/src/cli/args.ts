/**
 * Per-CLI extra arguments the user configured in Runova, keyed by CLI id, stored
 * exactly as typed (e.g. "--model sonnet"). Only background runs use these (commit
 * messages, tag suggestions, version bumps, skill audits). Terminal launches never do;
 * they take the launch defaults from Settings instead.
 */
export type CliArgsMap = Record<string, string>;

/**
 * Splits a typed argument line into argv entries the way a shell would: whitespace
 * separates, single and double quotes group. Backslashes stay literal so a Windows
 * path ("C:\work\repo") survives, which also means there is no escape character.
 */
export function parseCliArgs(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      // An empty quoted string is still an argument, so remember it was opened.
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) args.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current) args.push(current);
  return args;
}

/** Reads one CLI's argument line out of the settings map, trimmed, '' when unset. */
export function getCliArgsFor(map: CliArgsMap | undefined, cliId: string): string {
  return (map?.[cliId] ?? '').trim();
}

/** Same, already split into argv entries. */
export function getCliArgvFor(map: CliArgsMap | undefined, cliId: string): string[] {
  return parseCliArgs(getCliArgsFor(map, cliId));
}

/**
 * Keeps a settings file written by an older build (or edited by hand) from putting
 * a non-string where argv is expected. Blank entries are dropped so an emptied field
 * doesn't linger in settings.json.
 */
export function normalizeCliArgs(value: unknown): CliArgsMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: CliArgsMap = {};
  for (const [cliId, args] of Object.entries(value as Record<string, unknown>)) {
    if (typeof args !== 'string') continue;
    const trimmed = args.trim();
    if (trimmed) result[cliId] = trimmed;
  }
  return result;
}
