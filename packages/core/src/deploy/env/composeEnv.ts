import { type DotenvEntry, MAX_ENV_FILE_BYTES, parseDotenv } from '../../env/dotenv.js';
import { validateEnvKey } from '../validation.js';

/**
 * Renders the .env file a stack deploys with, so that Docker Compose reads back exactly the
 * values given, whether it uses the file to interpolate the compose file or as a service's
 * env_file. Compose's own dotenv parser (compose-go, dotenv/parser.go) decides the rules:
 *
 * - every value is double-quoted, so `#`, `=`, quotes and spaces at either end stay part of it;
 * - inside double quotes Compose expands `\\`, `\"`, `\n`, `\r`, `\t` and `\0` plus three octal
 *   digits, so backslashes, quotes and control characters are written as those escapes, which
 *   also keeps every entry on one line;
 * - double-quoted values are interpolated, so every `$` is written as `$$`.
 *
 * Checked against the real `docker compose config` in composeEnv.compose.test.ts.
 */

export const COMPOSE_ENV_HEADER =
  '# Written by Runova from the environment chosen for this app. Changes here are replaced on the next deploy.';

export type ComposeEnvResult =
  | { ok: true; text: string; keys: string[] }
  | { ok: false; reason: string; key?: string };

const ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  $: '$$',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** One value as Compose's dotenv parser needs to see it, quotes included. */
export function quoteComposeEnvValue(value: string): string {
  let quoted = '"';
  for (const char of value) {
    const escaped = ESCAPES[char];
    if (escaped !== undefined) {
      quoted += escaped;
      continue;
    }
    const code = char.charCodeAt(0);
    quoted += code < 0x20 || code === 0x7f ? `\\0${code.toString(8).padStart(3, '0')}` : char;
  }
  return `${quoted}"`;
}

/** Why a value cannot go into an environment at all, or null when it can. */
function valueProblem(value: string): string | null {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0) {
      return 'has a NUL character, and an environment variable ends at the first one';
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return 'has a broken Unicode character (half of a surrogate pair)';
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return 'has a broken Unicode character (half of a surrogate pair)';
    }
  }
  return null;
}

/**
 * The .env text for these entries, or the first reason one of them cannot be written. A key
 * listed twice keeps its last value, which is how dotenv reads a file that repeats a key.
 */
export function renderComposeEnv(
  entries: Iterable<Pick<DotenvEntry, 'key' | 'value'>>,
): ComposeEnvResult {
  const values = new Map<string, string>();
  for (const { key, value } of entries) {
    const checked = validateEnvKey(key);
    if (!checked.ok) {
      return {
        ok: false,
        key,
        reason: `The key ${JSON.stringify(key)} can't be used. ${checked.reason}`,
      };
    }
    const problem = valueProblem(value);
    if (problem) return { ok: false, key, reason: `The value of ${key} ${problem}.` };
    values.set(key, value);
  }

  let text = `${COMPOSE_ENV_HEADER}\n`;
  for (const [key, value] of values) text += `${key}=${quoteComposeEnvValue(value)}\n`;
  if (new TextEncoder().encode(text).length > MAX_ENV_FILE_BYTES) {
    return {
      ok: false,
      reason: `The environment comes to more than ${MAX_ENV_FILE_BYTES / (1024 * 1024)} MB, which is more than a .env file should hold.`,
    };
  }
  return { ok: true, text, keys: [...values.keys()] };
}

/**
 * Renders an env file from a project the way the Environments tab reads it, so the app gets the
 * values the user sees there, whatever quoting the original file used.
 */
export function renderComposeEnvFromDotenv(text: string): ComposeEnvResult {
  return renderComposeEnv(parseDotenv(text));
}
