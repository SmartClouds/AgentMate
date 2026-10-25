/** Ids and folder names for Studio videos. */

/** 16 lowercase letters and digits: short enough for a folder name, random enough to never clash. */
export function newId(): string {
  return globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16);
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_TITLE_CHARS = 40;

/**
 * `<title>-<first 8 of id>`: readable in a file manager, in any script (Persian titles stay
 * Persian), and safe on Windows, macOS and Linux.
 */
export function videoFolderName(title: string, id: string): string {
  return `${safeFolderName(title, 'video')}-${id.slice(0, 8)}`;
}

/** A file-name-safe version of `name`, or `fallback` when nothing usable is left. */
export function safeFolderName(name: string, fallback: string): string {
  let slug = name
    // Windows refuses these characters and every control character in a name.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/[<>:"/|?*\u0000-\u001f\u007f]+/g, (match) => (/\s/.test(match) ? ' ' : ''))
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  slug = [...slug]
    .slice(0, MAX_TITLE_CHARS)
    .join('')
    .replace(/[.-]+$/g, '');
  if (!slug) slug = fallback;
  if (RESERVED.test(slug)) slug = `${slug}_`;
  return slug;
}
