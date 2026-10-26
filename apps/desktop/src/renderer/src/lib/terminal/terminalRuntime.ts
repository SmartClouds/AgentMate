import { cleanTerminalTitle } from '@runova/core';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { create } from 'zustand';
import { commandForEvent, useShortcutStore } from '@/stores/shortcutStore';
import { useTerminalAppearanceStore } from '@/stores/terminalAppearanceStore';
import { useThemeStore } from '@/stores/themeStore';
import { agentReadyVerdict } from './agentReady';
import type { ChipInput, ChipPasteController } from './chipPasteMode';
import { claimTerminalFocus, releaseTerminalFocus } from './focusClaim';
import { onFontsLoaded, whenTerminalFontReady } from './fontReady';
import { attachTerminalPaste } from './pasteFiles';
import { createResizeSync, type ResizeSync } from './resizeSync';
import { describeTerminalStartError } from './startError';
import { attachRtlRendering } from './terminalRtl';
import {
  attachFocusOnClick,
  attachTerminalContextMenu,
  createXterm,
  resolveWorkspaceTerminalTheme,
} from './xtermFactory';

function currentTerminalTheme(): ReturnType<typeof resolveWorkspaceTerminalTheme> {
  const { customBackground, backgroundColor } = useTerminalAppearanceStore.getState();
  return resolveWorkspaceTerminalTheme(
    { customBackground, backgroundColor },
    useThemeStore.getState().theme,
  );
}

function applyTerminalTheme(entry: Entry): void {
  const { theme, wellBackground } = currentTerminalTheme();
  entry.term.options.theme = theme;
  entry.host.style.setProperty('--terminal-bg', wellBackground);
}

/**
 * Workspace terminals outlive the React components that show them. Switching projects,
 * reshaping a split or leaving the page would otherwise dispose every xterm and repaint it
 * from a snapshot on return. Instead each terminal lives here, and a pane borrows its DOM
 * element while on screen and hands it back to a hidden parking spot when it goes away.
 * The element keeps receiving output the whole time.
 */

export interface RuntimeSessionSpec {
  id: string;
  projectId: string;
  cwd?: string;
  shell?: string;
  cliId?: string;
  /** Typed into a brand-new shell once, e.g. the command that starts an agent. */
  initialInput?: string;
  /** From a previous run of the app: only reconnect, never start a new shell. */
  restored?: boolean;
}

interface Entry {
  spec: RuntimeSessionSpec;
  term: Terminal;
  fit: FitAddon;
  chipMode: ChipPasteController | null;
  /** Every size change goes through this, so xterm and the pty never disagree. */
  resize: ResizeSync;
  host: HTMLDivElement;
  /** The unpadded element xterm renders into, inside `host`. */
  surface: HTMLDivElement;
  opened: boolean;
  /** Focus was asked for before the terminal opened. */
  focusWhenOpen: boolean;
  started: boolean;
  /** Set once the snapshot is painted; until then output waits in `pending`. */
  ready: boolean;
  pending: string[];
  exitCode: number | null | undefined;
  /** When output last arrived, and how much has arrived, for the prompt hand-off below. */
  lastOutputAt: number;
  outputBytes: number;
  /** `outputBytes` at the point the program last turned bracketed paste on. */
  pasteModeOnAt: number;
  /** A prompt is already waiting for this session's CLI to start. */
  handingOff: boolean;
  mounted: boolean;
  lastVisibleAt: number;
  cleanups: (() => void)[];
}

interface PendingPrompt {
  text: string;
  /** Answered once the prompt lands, or once waiting for the CLI is given up on. */
  settle: (delivered: boolean) => void;
}

/** Prompts waiting for the CLI in their session to finish starting, keyed by session id. */
const pendingPrompts = new Map<string, PendingPrompt>();

/** DECSET 2004, what a program sends to turn bracketed paste on. */
const PASTE_MODE_ON = '\x1b[?2004h';
/** OSC 0/1/2 window title changes, ended by BEL or ST. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences start with ESC and end with BEL or ESC, matching them is the point
const TITLE_SEQUENCE = /\x1b\][012];[^\x07\x1b]*(?:\x07|\x1b\\)/g;

const PASTE_START = '[200~';
const PASTE_END = '[201~';

/**
 * Sends text to the program in the terminal as one bracketed paste, exactly the shape xterm's
 * own `paste` produces (newlines as carriage returns, any paste markers in the text dropped so
 * the block cannot be broken out of). It goes straight to the shell rather than through
 * `term.paste` because the chip-paste path relays a paste a character at a time, which for a
 * prompt of a few thousand characters would be a few thousand messages to the main process.
 */
function pasteAtOnce(entry: Entry, text: string): void {
  const body = text
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\r')
    .split(PASTE_START)
    .join('')
    .split(PASTE_END)
    .join('');
  void window.runova.terminal.write(entry.spec.id, PASTE_START + body + PASTE_END);
}

/**
 * Hands a queued prompt to the CLI the session is starting, once that CLI is up. The prompt is
 * pasted, never submitted: the user reads it in the CLI's own input box and presses Enter.
 *
 * A CLI that never looks ready (it is not installed, or the shell asked something first) gets
 * nothing. Pasting into a plain shell would run the prompt line by line, so the text goes back
 * to whoever queued it instead, to put somewhere safe.
 */
function handOffPrompt(entry: Entry): void {
  if (entry.handingOff || !pendingPrompts.has(entry.spec.id)) return;
  entry.handingOff = true;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const stop = (): void => {
      clearInterval(timer);
      entry.handingOff = false;
    };
    // The terminal was disposed under us (the tab closed, or it was evicted while parked).
    // The prompt stays queued, so a terminal created for the same session still gets it.
    if (entries.get(entry.spec.id) !== entry) {
      stop();
      return;
    }
    const now = Date.now();
    const verdict = agentReadyVerdict({
      bytes: entry.outputBytes - entry.pasteModeOnAt,
      elapsedMs: now - startedAt,
      quietMs: now - entry.lastOutputAt,
      bracketedPaste: entry.term.modes.bracketedPasteMode,
    });
    if (verdict === 'wait') return;
    stop();
    const queued = pendingPrompts.get(entry.spec.id);
    pendingPrompts.delete(entry.spec.id);
    if (!queued) return;
    if (verdict === 'ready') pasteAtOnce(entry, queued.text);
    queued.settle(verdict === 'ready');
  }, 100);
  entry.cleanups.push(() => clearInterval(timer));
}

/** Parked terminals past this count are disposed, oldest first. Their shells keep running. */
const MAX_LIVE_TERMINALS = 24;

const entries = new Map<string, Entry>();
/** Sessions this renderer already started, so a re-created entry reconnects instead. */
const startedOnce = new Set<string>();

interface SessionUiState {
  /** Sessions whose shell has ended. `null` means it did not survive an app restart. */
  ended: Record<string, number | null>;
  /** The latest window title each session's program set, cleaned up for display. */
  titles: Record<string, string>;
}

export const useTerminalSessionStore = create<SessionUiState>(() => ({ ended: {}, titles: {} }));

function markEnded(id: string, exitCode: number | null): void {
  useTerminalSessionStore.setState((state) => ({ ended: { ...state.ended, [id]: exitCode } }));
}

function forgetUiState(id: string): void {
  useTerminalSessionStore.setState((state) => {
    const { [id]: _ended, ...ended } = state.ended;
    const { [id]: _title, ...titles } = state.titles;
    return { ended, titles };
  });
}

let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  // Flipping the Settings toggle or picking a new color repaints every live terminal at once,
  // not just the next one created.
  useTerminalAppearanceStore.subscribe(() => {
    for (const entry of entries.values()) applyTerminalTheme(entry);
  });
  // Same for switching the app theme itself, since vscode-dark/vs2026 change the default
  // terminal palette too.
  useThemeStore.subscribe(() => {
    for (const entry of entries.values()) applyTerminalTheme(entry);
  });
  // A font that finishes loading later changes the cell size; refit so rows match it again.
  onFontsLoaded(() => {
    for (const entry of entries.values()) {
      if (entry.mounted) entry.resize.schedule();
    }
  });
  window.runova.terminal.onData(({ sessionId, data }) => {
    const entry = entries.get(sessionId);
    if (!entry) return;
    // A spinner in the window title (Codex animates one while it works) is not the CLI
    // drawing its screen, and counting it would keep the terminal from ever looking quiet.
    if (data.replace(TITLE_SEQUENCE, '').length > 0) entry.lastOutputAt = Date.now();
    const pasteOn = data.lastIndexOf(PASTE_MODE_ON);
    if (pasteOn !== -1) entry.pasteModeOnAt = entry.outputBytes + pasteOn + PASTE_MODE_ON.length;
    entry.outputBytes += data.length;
    if (entry.ready) entry.term.write(data);
    else entry.pending.push(data);
  });
  window.runova.terminal.onExit(({ sessionId, exitCode }) => {
    const entry = entries.get(sessionId);
    if (entry && !entry.ready) {
      entry.exitCode = exitCode;
      return;
    }
    markEnded(sessionId, exitCode);
  });
}

function parkingLot(): HTMLElement {
  let lot = document.getElementById('terminal-parking');
  if (!lot) {
    lot = document.createElement('div');
    lot.id = 'terminal-parking';
    lot.setAttribute('aria-hidden', 'true');
    lot.style.cssText =
      'position:fixed;left:-100000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;';
    document.body.appendChild(lot);
  }
  return lot;
}

function hasSize(entry: Entry): boolean {
  return entry.surface.clientWidth > 0 && entry.surface.clientHeight > 0;
}

function createEntry(spec: RuntimeSessionSpec): Entry {
  const host = document.createElement('div');
  host.className = 'terminal-pane absolute inset-0';
  // xterm opens into an inner box with no padding of its own. The fit addon measures the
  // element it opened in by its CSS size, which with border-box sizing includes padding,
  // so opening straight into the padded host sized the grid past the visible area.
  const surface = document.createElement('div');
  surface.style.cssText = 'width:100%;height:100%;overflow:hidden;';
  host.appendChild(surface);
  const { theme, wellBackground } = currentTerminalTheme();
  host.style.setProperty('--terminal-bg', wellBackground);
  const { term, fit, chipMode, imagePreview } = createXterm({
    sessionId: () => (entries.get(spec.id)?.ready ? spec.id : null),
    // Workspace pane, tab and diff keys go to the app, whatever the user bound them to.
    // Diff navigation is left out: a focused terminal is never showing a diff, and the key
    // (F7 by default) may mean something to the program running in it.
    passThrough: (event) => {
      const id = commandForEvent(event, useShortcutStore.getState().overrides, true, 'workspace');
      return id !== null && id !== 'workspace.nextChange' && id !== 'workspace.prevChange';
    },
    theme,
    shell: () => spec.shell,
  });
  const resize = createResizeSync({
    term,
    fit,
    canFit: () => entry.opened && hasSize(entry),
    resizePty: (cols, rows) => {
      if (entry.ready) void window.runova.terminal.resize(spec.id, cols, rows);
    },
  });
  const entry: Entry = {
    spec,
    term,
    fit,
    chipMode,
    resize,
    host,
    surface,
    opened: false,
    focusWhenOpen: false,
    started: false,
    ready: false,
    pending: [],
    exitCode: undefined,
    lastOutputAt: Date.now(),
    outputBytes: 0,
    pasteModeOnAt: 0,
    handingOff: false,
    mounted: false,
    lastVisibleAt: Date.now(),
    cleanups: [],
  };
  const titleListener = term.onTitleChange((raw) => {
    const { title } = cleanTerminalTitle(raw);
    useTerminalSessionStore.setState((state) =>
      state.titles[spec.id] === title ? state : { titles: { ...state.titles, [spec.id]: title } },
    );
  });
  // A split drag or panel animation reports a new size every frame. Only the size it settles
  // on goes to the pty; each one in between would make the CLI (and ConPTY) redraw for nothing.
  const observer = new ResizeObserver(() => resize.schedule());
  observer.observe(host);
  entry.cleanups.push(
    () => titleListener.dispose(),
    () => imagePreview.dispose(),
    () => observer.disconnect(),
    () => resize.dispose(),
  );
  entries.set(spec.id, entry);
  return entry;
}

function start(entry: Entry): void {
  entry.started = true;
  const { spec } = entry;
  const reconnectOnly = spec.restored === true || startedOnce.has(spec.id);
  startedOnce.add(spec.id);
  if (hasSize(entry)) entry.fit.fit();

  void window.runova.terminal
    .create({
      sessionId: spec.id,
      attachOnly: reconnectOnly,
      cwd: spec.cwd,
      shell: spec.shell,
      initialInput: reconnectOnly ? undefined : spec.initialInput,
      projectId: spec.projectId,
      cliId: spec.cliId,
      surface: 'workspace',
      ...(hasSize(entry) ? { cols: entry.term.cols, rows: entry.term.rows } : {}),
    })
    .then((result) => {
      if (entries.get(spec.id) !== entry) return;
      if (!result) {
        markEnded(spec.id, null);
        return;
      }
      const release = (fromSnapshot: boolean): void => {
        if (entries.get(spec.id) !== entry) return;
        entry.ready = true;
        for (const chunk of entry.pending) entry.term.write(chunk);
        entry.pending = [];
        if (entry.exitCode !== undefined) {
          markEnded(spec.id, entry.exitCode);
          return;
        }
        // A painted snapshot is not what ConPTY believes is on screen, so have it repaint.
        if (fromSnapshot && window.runova.platform === 'win32') entry.resize.repaint();
        else entry.resize.flush();
        // Layout can still be settling (a split just opened, a panel animating), so check
        // the size once more after it has, and tell the shell if it moved.
        setTimeout(() => {
          if (entries.get(spec.id) === entry) entry.resize.schedule();
        }, 250);
        handOffPrompt(entry);
      };
      const { snapshot } = result;
      if (!snapshot) {
        release(false);
        return;
      }
      // Repaint at the size the snapshot was taken at, then let the fit reflow it.
      if (snapshot.cols !== entry.term.cols || snapshot.rows !== entry.term.rows) {
        entry.term.resize(snapshot.cols, snapshot.rows);
      }
      entry.term.write(snapshot.data, () => release(true));
    })
    .catch((error: unknown) => {
      if (entries.get(spec.id) === entry) {
        entry.term.write(`\r\n\x1b[31m${describeTerminalStartError(error)}\x1b[0m\r\n`);
      }
    });
}

function disposeEntry(entry: Entry): void {
  releaseTerminalFocus(entry.host);
  for (const cleanup of entry.cleanups) cleanup();
  entry.chipMode?.dispose();
  entry.term.dispose();
  entry.host.remove();
  entries.delete(entry.spec.id);
}

function evictParked(): void {
  if (entries.size <= MAX_LIVE_TERMINALS) return;
  const parked = [...entries.values()]
    .filter((entry) => !entry.mounted)
    .sort((a, b) => a.lastVisibleAt - b.lastVisibleAt);
  for (const entry of parked) {
    if (entries.size <= MAX_LIVE_TERMINALS) break;
    disposeEntry(entry);
  }
}

export const terminalRuntime = {
  /** Shows a session's terminal inside `slot`, creating it (and its shell) on first use. */
  mount(spec: RuntimeSessionSpec, slot: HTMLElement): void {
    ensureSubscribed();
    const entry = entries.get(spec.id) ?? createEntry(spec);
    entry.mounted = true;
    entry.lastVisibleAt = Date.now();
    if (entry.host.parentElement !== slot) slot.appendChild(entry.host);
    if (entry.opened) {
      entry.resize.flush();
      return;
    }
    // Opening measures the character cell, so it waits for the terminal font (instant once
    // loaded). Measuring a fallback font would size the grid wider than what gets drawn.
    void whenTerminalFontReady().then(() => {
      if (entries.get(spec.id) !== entry || entry.opened) return;
      entry.term.open(entry.surface);
      entry.opened = true;
      entry.cleanups.push(
        attachTerminalContextMenu(
          entry.host,
          entry.term,
          () => spec.id,
          () => spec.shell,
          entry.chipMode,
        ),
        // Screenshots and copied files paste as chips when the shell is ready for them, or as
        // their real quoted paths otherwise, so agent CLIs can pick them up either way.
        attachTerminalPaste(entry.host, {
          chipMode: entry.chipMode,
          paste: (text) => entry.term.paste(text),
          shell: () => spec.shell,
        }),
        attachFocusOnClick(entry.host, entry.term),
        attachRtlRendering(entry.term),
      );
      if (entry.focusWhenOpen) {
        entry.focusWhenOpen = false;
        entry.term.focus();
      }
      if (!entry.started) start(entry);
      else entry.resize.flush();
    });
  },

  /** Takes the terminal off screen. It keeps running and receiving output. */
  unmount(id: string, slot: HTMLElement): void {
    const entry = entries.get(id);
    // Another pane may already have claimed it (a tab moved between groups).
    if (!entry || entry.host.parentElement !== slot) return;
    entry.mounted = false;
    entry.lastVisibleAt = Date.now();
    parkingLot().appendChild(entry.host);
    evictParked();
  },

  focus(id: string): void {
    const entry = entries.get(id);
    if (!entry) return;
    // A terminal still waiting on its font is not open yet; take focus the moment it is.
    if (entry.opened) entry.term.focus();
    else entry.focusWhenOpen = true;
    // The menu or dialog that opened it can still pull focus away as it closes.
    claimTerminalFocus({
      element: entry.host,
      canFocus: () => entries.get(id) === entry && entry.opened && entry.mounted && hasSize(entry),
      focus: () => entry.term.focus(),
    });
  },

  /**
   * Gives a session a prompt to hand to the agent CLI it is launching, as soon as that CLI is
   * ready for input. The session does not have to exist yet: a tab that has never been on screen
   * has no terminal, so the prompt waits until its shell starts. Resolves false when the CLI
   * never got there and the prompt was not typed anywhere.
   */
  deliverPrompt(id: string, text: string): Promise<boolean> {
    return new Promise((resolve) => {
      pendingPrompts.get(id)?.settle(false);
      pendingPrompts.set(id, { text, settle: resolve });
      const entry = entries.get(id);
      if (entry?.ready) handOffPrompt(entry);
    });
  },

  /** Types text into the session as if the user had, e.g. a dropped file path. */
  paste(id: string, text: string): void {
    const entry = entries.get(id);
    if (entry?.ready) entry.term.paste(text);
  },

  /**
   * Pastes text into the input box of the program running in the session, as one block and
   * unsubmitted. Only when that program turned bracketed paste on (an agent CLI waiting for
   * input does), since a bare shell would run the text. Returns false when nothing was typed.
   */
  insertText(id: string, text: string): boolean {
    const entry = entries.get(id);
    if (!entry?.ready || !entry.term.modes.bracketedPasteMode) return false;
    pasteAtOnce(entry, text);
    return true;
  },

  /** Same as `paste`, but as chips when the shell is ready for them (e.g. a dropped file). */
  pasteChips(id: string, chips: ChipInput[]): void {
    const entry = entries.get(id);
    if (!entry?.ready) return;
    if (entry.chipMode?.insertChips(chips)) {
      entry.chipMode.insertText(' ');
      return;
    }
    entry.term.paste(`${chips.map((chip) => chip.realText).join(' ')} `);
  },

  /** Drops the terminal for good. Ending the shell itself is the caller's call. */
  dispose(id: string): void {
    const entry = entries.get(id);
    if (entry) disposeEntry(entry);
    pendingPrompts.get(id)?.settle(false);
    pendingPrompts.delete(id);
    startedOnce.delete(id);
    forgetUiState(id);
  },
};
