import { LEGACY_BLUEPRINT_FILE_SCHEME } from '../legacyNames.js';

/**
 * Blueprint files are referenced from inside a step's markdown rather than
 * hanging off the step as a list, so a screenshot can sit between the sentence
 * that introduces it and the one that follows.
 *
 * They are addressed through the app's own URL scheme, served by the main
 * process straight off disk. That is what lets a 30 MB screen recording play
 * (and seek) in the preview: a data URL would mean base64-ing the whole thing
 * into the renderer first.
 */
export const BLUEPRINT_FILE_SCHEME = 'runova-file';
export const BLUEPRINT_FILE_HOST = 'blueprint';

/**
 * Links saved before the app was renamed use the old scheme. Rewritten when a blueprint is read,
 * so they keep pointing at their files.
 */
export function relinkLegacyAttachments(text: string): string {
  return text.includes(`${LEGACY_BLUEPRINT_FILE_SCHEME}://`)
    ? text.replaceAll(`${LEGACY_BLUEPRINT_FILE_SCHEME}://`, `${BLUEPRINT_FILE_SCHEME}://`)
    : text;
}

export function blueprintFileUrl(fileName: string): string {
  return `${BLUEPRINT_FILE_SCHEME}://${BLUEPRINT_FILE_HOST}/${encodeURIComponent(fileName)}`;
}

/** Reverses `blueprintFileUrl`. Null for anything that isn't one of ours. */
export function blueprintFileNameFromUrl(url: string): string | null {
  const prefix = `${BLUEPRINT_FILE_SCHEME}://${BLUEPRINT_FILE_HOST}/`;
  if (!url.startsWith(prefix)) return null;
  const raw = url.slice(prefix.length).split(/[?#]/)[0];
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return null;
  }
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

export function isVideoMime(mime: string): boolean {
  return mime.startsWith('video/');
}

/** True for the types the preview can draw in place rather than link to. */
export function isInlineMedia(mime: string): boolean {
  return isImageMime(mime) || isVideoMime(mime);
}

/**
 * The markdown to drop at the caret for one file.
 *
 * Video uses image syntax on purpose: `![]()` is the only media form plain
 * markdown has, and the preview swaps in a `<video>` when the file behind the
 * URL is one. That keeps a step's text as ordinary markdown, so it still reads
 * correctly anywhere else it ends up.
 */
export function blueprintFileMarkdown(attachment: {
  fileName: string;
  displayName: string;
  mime: string;
}): string {
  // A `]` or a newline in the name would end the link early.
  const alt = attachment.displayName.replace(/[[\]\r\n]/g, ' ').trim() || 'attachment';
  const url = blueprintFileUrl(attachment.fileName);
  return isInlineMedia(attachment.mime) ? `![${alt}](${url})` : `[${alt}](${url})`;
}

const FILE_REF = new RegExp(
  `!?\\[([^\\]]*)\\]\\(\\s*<?(${BLUEPRINT_FILE_SCHEME}://[^\\s)>]*)>?[^)]*\\)`,
  'g',
);

/** The files a step's markdown actually points at, so a delete can say what it will break. */
export function referencedAttachmentNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(FILE_REF)) {
    const fileName = blueprintFileNameFromUrl(match[2]);
    if (fileName) names.add(fileName);
  }
  return names;
}

/**
 * Swaps every file reference for a plain mention of what was there.
 *
 * This runs before a step is translated and before it reaches the generated
 * prompt or the project's markdown. Both of those are read somewhere the app's
 * URL scheme means nothing, so an embedded `![](runova-file://…)` would be a
 * dead link; the name is the part that carries the information.
 */
export function flattenAttachmentRefs(text: string): string {
  return text.replace(FILE_REF, (_match, alt: string) => {
    const name = alt.trim();
    return name ? `[attached file: ${name}]` : '[attached file]';
  });
}

/**
 * Drops every reference to one file from a step's markdown, used when the file
 * itself is removed. Leaving them behind would render as a broken image with no
 * way to clear it except editing the source by hand.
 */
export function removeAttachmentRefs(text: string, fileName: string): string {
  return text
    .replace(FILE_REF, (match, _alt: string, url: string) =>
      blueprintFileNameFromUrl(url) === fileName ? '' : match,
    )
    .replace(/\n{3,}/g, '\n\n');
}
