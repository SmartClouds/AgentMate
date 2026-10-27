/**
 * Repairs clipboard text from the server that the engine decoded as the wrong format.
 *
 * The engine asks the server for one clipboard format at a time and assumes each answer belongs
 * to the format it asked for last. When the server announces its clipboard twice in quick
 * succession (Edge's "Copy link" does), an answer meant for the first announcement is filed
 * under the second one's queue. The UTF-8 "HTML Format" bytes then get read as UTF-16 text, so
 * the copied link arrives as a line of CJK-looking characters, and the real plain text is
 * dropped. The bytes survive the bad decode, so they can be put back together here.
 */

/** The parts of the engine's clipboard classes this repair touches. */
export interface EngineClipboardItem {
  mimeType(): string;
  value(): unknown;
}

export interface EngineClipboardData {
  items(): EngineClipboardItem[];
  addText(mimeType: string, text: string): void;
  addBinary(mimeType: string, binary: Uint8Array): void;
}

/** Every CF_HTML payload starts with its version header. */
const CF_HTML_PREFIX = 'Version:';

/** The bytes a string decoded as UTF-16LE came from. */
function utf16leBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    bytes[i * 2] = unit & 0xff;
    bytes[i * 2 + 1] = unit >> 8;
  }
  return bytes;
}

function headerOffset(header: string, name: string): number | null {
  const match = new RegExp(`^${name}:(-?\\d+)\\s*$`, 'm').exec(header);
  return match ? Number(match[1]) : null;
}

/**
 * If `text` is a CF_HTML payload that was read as UTF-16, returns the HTML fragment it carries.
 * Returns null for anything else, which includes every real piece of text: no language puts
 * "Version:" in the code units this check looks for.
 */
export function misreadCfHtmlFragment(text: string): string | null {
  const bytes = utf16leBytes(text);
  // One character per byte, so string positions here are the byte offsets the header uses.
  const raw = new TextDecoder('windows-1252').decode(bytes);
  if (!raw.startsWith(CF_HTML_PREFIX)) return null;

  const decoder = new TextDecoder('utf-8');
  const header = raw.slice(0, Math.max(0, raw.indexOf('<')));
  const from = headerOffset(header, 'StartFragment');
  const to = headerOffset(header, 'EndFragment');
  if (from !== null && to !== null && 0 <= from && from < to && to <= bytes.length) {
    return decoder.decode(bytes.subarray(from, to));
  }

  const html = decoder.decode(bytes);
  const marked = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/.exec(html);
  return marked ? (marked[1] ?? '') : null;
}

/**
 * The plain text that goes with an HTML fragment. A fragment that is just one link is what
 * browsers put down for "Copy link", whose plain text is the address, not the page title.
 */
export function plainTextOfFragment(fragment: string): string {
  const body = new DOMParser().parseFromString(fragment, 'text/html').body;
  const only = body.children.length === 1 ? body.children[0] : null;
  const href = only instanceof HTMLAnchorElement ? only.getAttribute('href') : null;
  if (href && only?.textContent?.trim() === body.textContent?.trim()) return href;
  return body.textContent?.trim() ?? '';
}

/**
 * Returns clipboard data with a misread "HTML Format" payload turned back into HTML and plain
 * text, or `data` itself when nothing in it was misread.
 */
export function repairRemoteClipboard<T extends EngineClipboardData>(data: T, create: () => T): T {
  const items = data.items();
  let fragment: string | null = null;
  for (const item of items) {
    const value = item.value();
    if (item.mimeType() === 'text/plain' && typeof value === 'string') {
      fragment = misreadCfHtmlFragment(value);
      if (fragment !== null) break;
    }
  }
  if (fragment === null) return data;

  const repaired = create();
  const hasHtml = items.some((item) => item.mimeType() === 'text/html');
  for (const item of items) {
    const mimeType = item.mimeType();
    const value = item.value();
    if (mimeType === 'text/plain') continue;
    if (typeof value === 'string') repaired.addText(mimeType, value);
    else if (value instanceof Uint8Array) repaired.addBinary(mimeType, value);
  }
  if (!hasHtml) repaired.addText('text/html', fragment);
  repaired.addText('text/plain', plainTextOfFragment(fragment));
  return repaired;
}
