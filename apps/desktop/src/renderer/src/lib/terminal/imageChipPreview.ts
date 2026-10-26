import type { IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { openImageViewer } from '@/stores/imageViewerStore';

/**
 * Shows the actual image when hovering an `[Image #N]` label an agent CLI (Claude Code) draws
 * after an image path is pasted into it.
 *
 * The CLI draws that label itself, so the terminal never learns which file a number stands for.
 * Instead, whenever an image path goes out to the pty, the visible screen is checked for which
 * `[Image #N]` labels appear more often than before, and those numbers are tied to the pasted
 * paths in order. Counting against the screen (rather than guessing "the next number") keeps it
 * right when the CLI spends numbers on other things, like a large text paste.
 *
 * A new CLI session starts counting from 1 again, so one number can mean different images over a
 * terminal's life. Each mapping remembers the row its label first appeared on, and a label in the
 * scrollback resolves to the latest mapping at or above it.
 */

const IMAGE_LABEL = /\[Image #(\d+)\]/g;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** How long to wait for the CLI to draw its label after a paste. */
const WATCH_MS = 3000;
/** How far below its first row a label can later be redrawn and still count as the same one
 * (the CLI reprints a submitted prompt a few rows off from where it was typed). */
const ROW_SLACK = 6;
const HOVER_DELAY_MS = 300;
const HIDE_GRACE_MS = 250;
const MAX_MAPPINGS = 200;

interface Mapping {
  path: string;
  /** Null when the label was found on the alternate screen, which has no scrollback. */
  marker: IMarker | null;
}

export interface ImageChipPreview {
  /** Looks for image paths in data headed to the pty and, if any, watches for their labels. */
  noteOutgoing(data: string): void;
  dispose(): void;
}

/** Image file paths in text typed or pasted into a shell, quoted or not. */
export function imagePathsIn(text: string): string[] {
  // Bracketed-paste markers and other escape sequences are not part of any path.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC starts every escape sequence, matching it is the point
  const clean = text.replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, ' ');
  const paths: string[] = [];
  const token = /'((?:[^']|'')*)'|"((?:[^"]|"")*)"|((?:\\ |[^\s'"])+)/g;
  for (const match of clean.matchAll(token)) {
    let value: string;
    if (match[1] !== undefined) value = match[1].replace(/''/g, "'");
    else if (match[2] !== undefined) value = match[2].replace(/""/g, '"');
    // Backslashes are path separators on Windows and escapes everywhere else.
    else if (/^[A-Za-z]:\\/.test(match[3])) value = match[3];
    else value = match[3].replace(/\\(.)/g, '$1');
    if (IMAGE_EXTENSION.test(value) && /^([A-Za-z]:[\\/]|\/|~\/|\\\\)/.test(value)) {
      paths.push(value);
    }
  }
  return paths;
}

function countLabels(term: Terminal): Map<number, { count: number; row: number }> {
  const buffer = term.buffer.active;
  const counts = new Map<number, { count: number; row: number }>();
  for (let y = buffer.viewportY; y < buffer.viewportY + term.rows; y++) {
    const text = buffer.getLine(y)?.translateToString(true) ?? '';
    for (const match of text.matchAll(IMAGE_LABEL)) {
      const n = Number(match[1]);
      const seen = counts.get(n);
      counts.set(n, { count: (seen?.count ?? 0) + 1, row: seen?.row ?? y });
    }
  }
  return counts;
}

const previewCache = new Map<string, Promise<string | null>>();

function loadPreview(path: string): Promise<string | null> {
  let pending = previewCache.get(path);
  if (!pending) {
    pending = window.runova.terminalClipboard.previewImage(path).catch(() => null);
    previewCache.set(path, pending);
    // Only the last few hovered images stay in memory.
    if (previewCache.size > 20) previewCache.delete(previewCache.keys().next().value as string);
  }
  return pending;
}

let bubble: HTMLDivElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let cancelLoad: (() => void) | null = null;

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

function hideBubble(): void {
  clearTimeout(hideTimer);
  cancelLoad?.();
  cancelLoad = null;
  if (!bubble) return;
  bubble.style.display = 'none';
  bubble.replaceChildren();
  delete bubble.dataset.path;
}

/** Leaving the label hides the preview only after a moment, long enough for the pointer to cross
 * the gap onto the preview itself, which keeps it open so it can be clicked. */
function hideBubbleSoon(): void {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideBubble, HIDE_GRACE_MS);
}

/** One bubble for the whole window: only one label can be hovered at a time. */
function ensureBubble(): HTMLDivElement {
  if (bubble) return bubble;
  const el = document.createElement('div');
  // Same look as the app's tooltip component.
  el.className =
    'fixed z-50 flex-col gap-1.5 overflow-hidden rounded-lg border border-white/15 bg-popover/70 p-1.5 text-xs font-medium text-popover-foreground shadow-2xl backdrop-blur-xl animate-in fade-in-0 zoom-in-95';
  el.style.display = 'none';
  el.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  el.addEventListener('mouseleave', hideBubbleSoon);
  el.addEventListener('click', () => {
    const { path } = el.dataset;
    if (!path) return;
    hideBubble();
    openImageViewer(path);
  });
  document.body.appendChild(el);
  bubble = el;
  return el;
}

function showBubble(path: string, x: number, y: number): void {
  hideBubble();
  const el = ensureBubble();
  let cancelled = false;
  cancelLoad = () => {
    cancelled = true;
  };

  const place = (): void => {
    const gap = 6;
    const rect = el.getBoundingClientRect();
    const left = Math.min(Math.max(8, x - rect.width / 2), window.innerWidth - rect.width - 8);
    // Above the pointer when it fits, so the label itself stays visible; below otherwise.
    const top = y - rect.height - gap >= 8 ? y - rect.height - gap : y + gap;
    el.style.left = `${left}px`;
    el.style.top = `${Math.min(top, window.innerHeight - rect.height - 8)}px`;
  };

  void loadPreview(path).then((url) => {
    if (cancelled) return;
    const caption = document.createElement('div');
    caption.className = 'max-w-[480px] truncate px-1 text-muted-foreground';
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.className = 'block max-h-[320px] max-w-[480px] rounded-md object-contain';
      img.onload = () => {
        if (!cancelled) place();
      };
      caption.textContent = `${fileName(path)} · Click to view full size`;
      el.dataset.path = path;
      el.style.cursor = 'zoom-in';
      el.append(img, caption);
    } else {
      caption.textContent = `${fileName(path)} is no longer available`;
      el.style.cursor = '';
      el.append(caption);
    }
    el.style.display = 'flex';
    place();
  });
}

export function createImageChipPreview(term: Terminal): ImageChipPreview {
  const mappings = new Map<number, Mapping[]>();
  let mappingCount = 0;
  let watch: { paths: string[]; before: Map<number, { count: number }>; stop: () => void } | null =
    null;

  function remember(n: number, path: string, row: number): void {
    const buffer = term.buffer.active;
    const marker =
      buffer.type === 'normal'
        ? (term.registerMarker(row - (buffer.baseY + buffer.cursorY)) ?? null)
        : null;
    const list = mappings.get(n) ?? [];
    list.push({ path, marker });
    mappings.set(n, list);
    mappingCount += 1;
    if (mappingCount > MAX_MAPPINGS) {
      // Drop the oldest mapping of whichever number has the most history.
      const [, longest] = [...mappings].sort((a, b) => b[1].length - a[1].length)[0];
      longest.shift()?.marker?.dispose();
      mappingCount -= 1;
    }
  }

  function check(): void {
    if (!watch) return;
    const after = countLabels(term);
    const added = [...after]
      .filter(([n, { count }]) => count > (watch?.before.get(n)?.count ?? 0))
      .sort((a, b) => a[0] - b[0]);
    if (added.length === 0) return;
    // Lowest new number first, matched to the pasted paths in the order they went out.
    const matched = Math.min(added.length, watch.paths.length);
    for (let i = 0; i < matched; i++) remember(added[i][0], watch.paths[i], added[i][1].row);
    watch.paths = watch.paths.slice(matched);
    watch.before = after;
    if (watch.paths.length === 0) watch.stop();
  }

  function startWatch(paths: string[]): void {
    watch?.stop();
    const before = countLabels(term);
    const parsed = term.onWriteParsed(() => check());
    const timer = setTimeout(() => watch?.stop(), WATCH_MS);
    const current = {
      paths,
      before,
      stop: () => {
        parsed.dispose();
        clearTimeout(timer);
        if (watch === current) watch = null;
      },
    };
    watch = current;
  }

  function mappingFor(n: number, row: number): Mapping | undefined {
    const list = mappings.get(n);
    if (!list?.length) return undefined;
    if (term.buffer.active.type === 'alternate') return list[list.length - 1];
    // Latest mapping whose label first showed at or above this row. A marker that scrolled out
    // of the scrollback reports -1, which keeps it in play as the oldest.
    for (let i = list.length - 1; i >= 0; i--) {
      const line = list[i].marker?.line ?? -1;
      if (line <= row + ROW_SLACK) return list[i];
    }
    return list[0];
  }

  let hoverTimer: ReturnType<typeof setTimeout> | undefined;

  const linkProvider: IDisposable = term.registerLinkProvider({
    provideLinks(y, callback) {
      if (mappings.size === 0) {
        callback(undefined);
        return;
      }
      const row = y - 1;
      const text = term.buffer.active.getLine(row)?.translateToString(true) ?? '';
      const links = [...text.matchAll(IMAGE_LABEL)].flatMap((match) => {
        const mapping = mappingFor(Number(match[1]), row);
        if (!mapping) return [];
        const start = (match.index ?? 0) + 1;
        return [
          {
            range: { start: { x: start, y }, end: { x: start + match[0].length - 1, y } },
            text: match[0],
            decorations: { pointerCursor: true, underline: true },
            // Ctrl/Cmd+click opens it full size, like a URL; a plain click still selects text.
            activate: (event: MouseEvent) => {
              if (!event.ctrlKey && !event.metaKey) return;
              clearTimeout(hoverTimer);
              hideBubble();
              openImageViewer(mapping.path);
            },
            hover: (event: MouseEvent) => {
              clearTimeout(hoverTimer);
              // Back on the label from its own preview: keep what's already showing.
              if (bubble?.style.display !== 'none' && bubble?.dataset.path === mapping.path) {
                clearTimeout(hideTimer);
                return;
              }
              const { clientX, clientY } = event;
              hoverTimer = setTimeout(
                () => showBubble(mapping.path, clientX, clientY),
                HOVER_DELAY_MS,
              );
            },
            leave: () => {
              clearTimeout(hoverTimer);
              hideBubbleSoon();
            },
          },
        ];
      });
      callback(links.length ? links : undefined);
    },
  });

  return {
    noteOutgoing(data) {
      // Most chunks are single keystrokes; only look for paths in one that names an image.
      if (!/\.(png|jpe?g|gif|webp|bmp)\b/i.test(data)) return;
      const paths = imagePathsIn(data);
      if (paths.length) startWatch(paths);
    },
    dispose() {
      watch?.stop();
      clearTimeout(hoverTimer);
      hideBubble();
      linkProvider.dispose();
      for (const list of mappings.values()) for (const mapping of list) mapping.marker?.dispose();
      mappings.clear();
    },
  };
}
