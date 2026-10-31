import { compareVersions } from '@runova/core';
import type { RuntimeKind } from '../../shared/apiTypes';

/**
 * Reading the runtime a project declares, and writing a newer one back. Every rewrite is a text
 * edit of the one value, so the rest of the file (formatting, comments, key order, line endings)
 * comes back exactly as it was. A value whose shape is not one of the simple, common forms is
 * reported but never rewritten: the AI prompt is the way to move those.
 */

// --- Versions -----------------------------------------------------------------

/** `latest` cut to as many parts as `like` has, so `>=20` moves to `>=24`, not `>=24.11.1`. */
export function samePrecision(latest: string, like: string): string {
  const parts = like.split('.').length;
  return latest.split('.').slice(0, parts).join('.');
}

/** True when `latest`, at the precision `current` is written in, is newer than it. */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(samePrecision(latest, current), current) > 0;
}

// --- package.json ---------------------------------------------------------------

const PACKAGE_MANAGER = /^(bun|pnpm|npm|yarn)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.*)?$/;

export interface PackageManagerPin {
  kind: Extract<RuntimeKind, 'bun' | 'pnpm' | 'npm' | 'yarn'>;
  version: string;
}

export function parsePackageManagerPin(value: unknown): PackageManagerPin | null {
  if (typeof value !== 'string') return null;
  const match = PACKAGE_MANAGER.exec(value.trim());
  if (!match) return null;
  return { kind: match[1] as PackageManagerPin['kind'], version: match[2] };
}

/** The forms an engines range is rewritten in: `24`, `^24.1`, `~24.1.0`, `>=24`. */
const SIMPLE_RANGE = /^(\^|~|>=)?\s*v?(\d+(?:\.\d+){0,2})$/;

export interface SimpleRange {
  operator: string;
  version: string;
}

export function parseSimpleRange(range: string): SimpleRange | null {
  const match = SIMPLE_RANGE.exec(range.trim());
  return match ? { operator: match[1] ?? '', version: match[2] } : null;
}

/** The first version a range names, for display when the range is too complex to rewrite. */
export function lowerBound(range: string): string | null {
  return /(\d+(?:\.\d+){0,2})/.exec(range)?.[1] ?? null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces the string value of a top-level `"key": "..."`. Null when the key is not there. */
export function rewritePackageManager(source: string, value: string): string | null {
  const pattern = /("packageManager"\s*:\s*")([^"]*)(")/;
  return pattern.test(source) ? source.replace(pattern, `$1${value}$3`) : null;
}

/** Replaces `engines.<engine>`. Null when there is no such entry. */
export function rewriteEngine(source: string, engine: string, value: string): string | null {
  const pattern = new RegExp(
    `("engines"\\s*:\\s*\\{[^}]*?"${escapeRegExp(engine)}"\\s*:\\s*")([^"]*)(")`,
  );
  return pattern.test(source)
    ? source.replace(pattern, (_m, a, _old, c) => `${a}${value}${c}`)
    : null;
}

// --- .NET -----------------------------------------------------------------------

export interface TargetFramework {
  /** `8.0` for `net8.0`, `net8.0-android` and `netcoreapp8.0`. */
  version: string;
  /** The platform part, kept on rewrite: `-android`, `-windows10.0.19041.0`. */
  suffix: string;
}

/** Only .NET (Core) target frameworks. .NET Framework (`net48`) and netstandard return null. */
export function parseTargetFramework(tfm: string): TargetFramework | null {
  const match = /^net(?:coreapp)?(\d+\.\d+)(-[A-Za-z][A-Za-z0-9.]*)?$/.exec(tfm.trim());
  if (!match) return null;
  return { version: match[1], suffix: match[2] ?? '' };
}

function commentRanges(xml: string): [number, number][] {
  return [...xml.matchAll(/<!--[\s\S]*?-->/g)].map((m) => [m.index, m.index + m[0].length]);
}

/** The first match of `pattern` (which must be global) that does not sit inside an XML comment. */
function firstOutsideComments(xml: string, pattern: RegExp): RegExpExecArray | null {
  const ranges = commentRanges(xml);
  for (const match of xml.matchAll(pattern)) {
    if (!ranges.some(([start, end]) => match.index >= start && match.index < end)) {
      return match as RegExpExecArray;
    }
  }
  return null;
}

const SINGLE_TFM = /<TargetFramework>\s*([^<]*?)\s*<\/TargetFramework>/g;
const MULTI_TFM = /<TargetFrameworks>\s*([^<]*?)\s*<\/TargetFrameworks>/g;

export interface DeclaredTargetFramework {
  declared: string;
  /** True for a `<TargetFrameworks>` list, which is shown but not rewritten. */
  multiple: boolean;
}

export function readTargetFramework(xml: string): DeclaredTargetFramework | null {
  const single = firstOutsideComments(xml, SINGLE_TFM);
  if (single) return { declared: single[1], multiple: false };
  const multi = firstOutsideComments(xml, MULTI_TFM);
  if (multi) return { declared: multi[1], multiple: true };
  return null;
}

export function rewriteTargetFramework(xml: string, tfm: string): string | null {
  const match = firstOutsideComments(xml, SINGLE_TFM);
  if (!match) return null;
  const replacement = match[0].replace(match[1], tfm);
  return xml.slice(0, match.index) + replacement + xml.slice(match.index + match[0].length);
}

/** Replaces `sdk.version` in a global.json. Null when there is none. */
export function rewriteGlobalJsonSdk(source: string, version: string): string | null {
  const pattern = /("sdk"\s*:\s*\{[^}]*?"version"\s*:\s*")([^"]*)(")/;
  return pattern.test(source) ? source.replace(pattern, `$1${version}$3`) : null;
}

export function readGlobalJsonSdk(source: string): string | null {
  try {
    const data = JSON.parse(source) as { sdk?: { version?: unknown } };
    return typeof data.sdk?.version === 'string' ? data.sdk.version : null;
  } catch {
    return null;
  }
}

// --- pubspec.yaml ---------------------------------------------------------------

export interface DartConstraint {
  /** The version the constraint starts from. */
  lower: string;
  /** The same form of constraint, starting from a newer version. */
  next: (latest: string) => string;
}

/**
 * The SDK constraint forms pub itself writes: `^3.5.0`, `'>=3.5.0 <4.0.0'` and `'>=3.5.0'`.
 * Quotes are kept as they were. Anything else returns null.
 */
export function parseDartConstraint(raw: string): DartConstraint | null {
  const value = raw.trim();
  const quote = /^(["'])(.*)\1$/.exec(value);
  const q = quote?.[1] ?? '';
  const inner = (quote?.[2] ?? value).trim();
  const wrap = (text: string): string => `${q}${text}${q}`;

  const caret = /^\^(\d+\.\d+\.\d+)$/.exec(inner);
  if (caret) return { lower: caret[1], next: (latest) => wrap(`^${latest}`) };

  const range = /^>=\s*(\d+\.\d+\.\d+)\s+<\s*(\d+\.\d+\.\d+)$/.exec(inner);
  // A range has to be quoted in YAML, so one written bare is left alone.
  if (range && q) {
    return {
      lower: range[1],
      next: (latest) => wrap(`>=${latest} <${Number(latest.split('.')[0]) + 1}.0.0`),
    };
  }

  const min = /^>=\s*(\d+\.\d+\.\d+)$/.exec(inner);
  if (min && q) return { lower: min[1], next: (latest) => wrap(`>=${latest}`) };
  return null;
}

const ENVIRONMENT_LINE = /^environment\s*:\s*(#.*)?$/;
const ENTRY_LINE = /^(\s+)([A-Za-z_]+)(\s*:\s*)(.*?)(\s+#.*)?$/;

/** The raw values under pubspec's `environment:`, e.g. `{ sdk: "^3.5.0", flutter: ">=3.24.0" }`. */
export function readPubspecEnvironment(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  let inside = false;
  for (const line of source.split(/\r?\n/)) {
    if (ENVIRONMENT_LINE.test(line)) {
      inside = true;
      continue;
    }
    if (!inside || !line.trim() || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const match = ENTRY_LINE.exec(line);
    if (match?.[4]) values[match[2]] = match[4];
  }
  return values;
}

/** Replaces the value of `environment.<key>`, keeping indentation and any trailing comment. */
export function rewritePubspecEnvironment(
  source: string,
  key: string,
  value: string,
): string | null {
  const lines = source.split(/(\r?\n)/);
  let inside = false;
  // Odd indices hold the line breaks themselves.
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    if (ENVIRONMENT_LINE.test(line)) {
      inside = true;
      continue;
    }
    if (!inside || !line.trim() || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) return null;
    const match = ENTRY_LINE.exec(line);
    if (match && match[2] === key && match[4]) {
      lines[i] = `${match[1]}${match[2]}${match[3]}${value}${match[5] ?? ''}`;
      return lines.join('');
    }
  }
  return null;
}
