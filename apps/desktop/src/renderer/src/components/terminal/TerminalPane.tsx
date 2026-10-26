import type { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { containerConsoleAdapter } from '@/lib/terminal/containerConsoleAdapter';
import { claimTerminalFocus, releaseTerminalFocus } from '@/lib/terminal/focusClaim';
import { onFontsLoaded, whenTerminalFontReady } from '@/lib/terminal/fontReady';
import { attachTerminalPaste } from '@/lib/terminal/pasteFiles';
import { createResizeSync } from '@/lib/terminal/resizeSync';
import { sshTerminalAdapter } from '@/lib/terminal/sshAdapter';
import { describeTerminalStartError } from '@/lib/terminal/startError';
import { attachRtlRendering } from '@/lib/terminal/terminalRtl';
import {
  attachFocusOnClick,
  attachTerminalContextMenu,
  createXterm,
  resolveDrawerTerminalTheme,
} from '@/lib/terminal/xtermFactory';
import type { TerminalSessionMeta } from '@/stores/terminalStore';
import { useThemeStore } from '@/stores/themeStore';
import { SshPasswordButton } from './SshPasswordButton';

export interface TerminalPaneProps {
  meta: TerminalSessionMeta;
  active: boolean;
  onExit: () => void;
}

export function TerminalPane({ meta, active, onExit }: TerminalPaneProps): React.JSX.Element {
  const paneRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per mount; the pty session and terminal instance are managed via refs/closures, not props
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let ptySessionId: string | null = null;
    let disposed = false;
    // SSH sessions and container consoles run somewhere else: no local pty, no shell integration.
    const remote = meta.kind === 'ssh' || meta.kind === 'container';
    const client =
      meta.kind === 'container' && meta.container
        ? containerConsoleAdapter(meta.container.serverId, meta.container.containerId, {
            command: meta.container.command,
            user: meta.container.user,
          })
        : meta.kind === 'ssh' && meta.sshServerId
          ? sshTerminalAdapter(meta.sshServerId)
          : window.runova.terminal;
    const initialTheme = resolveDrawerTerminalTheme(useThemeStore.getState().theme);
    paneRef.current?.style.setProperty('--terminal-bg', initialTheme.background as string);
    const {
      term,
      fit: fitAddon,
      chipMode,
      imagePreview,
    } = createXterm({
      sessionId: () => ptySessionId,
      write: (id, data) => void client.write(id, data),
      theme: initialTheme,
      // No shell-integration marker is ever injected into a remote shell, so SSH panes just
      // never see it ready and stay on today's raw-path paste behavior.
      chipPasteMode: !remote,
      shell: () => meta.shell,
      localPty: !remote,
    });
    termRef.current = term;

    const unsubscribeTheme = useThemeStore.subscribe((state) => {
      const theme = resolveDrawerTerminalTheme(state.theme);
      term.options.theme = theme;
      paneRef.current?.style.setProperty('--terminal-bg', theme.background as string);
    });

    const hasSize = (): boolean => container.clientWidth > 0 && container.clientHeight > 0;

    const resizeSync = createResizeSync({
      term,
      fit: fitAddon,
      // A hidden pane (inactive tab, or the whole drawer closed) measures 0x0.
      // Fitting to that would reflow the running program's output to a garbage
      // size, so wait until it is on screen again. Hiding must not disturb the pty.
      canFit: () => hasSize() && term.element !== undefined,
      resizePty: (cols, rows) => {
        if (ptySessionId) void client.resize(ptySessionId, cols, rows);
      },
    });
    const resizeObserver = new ResizeObserver(() => resizeSync.schedule());
    resizeObserver.observe(container);
    const stopFontWatch = onFontsLoaded(() => resizeSync.schedule());

    const detachFocusOnClick = attachFocusOnClick(paneRef.current ?? container, term);
    // Set once the terminal opens, since it needs xterm's rows to exist.
    let detachRtl = (): void => undefined;
    const detachContextMenu = attachTerminalContextMenu(
      container,
      term,
      () => ptySessionId,
      () => meta.shell,
      chipMode,
    );
    // Screenshots and copied files paste as chips when the shell is ready for them, or as
    // their real quoted paths otherwise, so agent CLIs can pick them up either way.
    const detachFilePaste = attachTerminalPaste(container, {
      chipMode,
      paste: (text) => term.paste(text),
      shell: () => meta.shell,
    });

    // The session id is the tab id, which is what lets a pane find its shell again after
    // the app restarts. Subscribing before the create call means no output is missed:
    // anything that arrives before the snapshot is painted waits in `pending`.
    const sessionId = meta.id;
    let pending: string[] | null = [];
    let exited = false;

    const unsubscribeData = client.onData((payload) => {
      if (payload.sessionId !== sessionId) return;
      if (pending) pending.push(payload.data);
      else term.write(payload.data);
    });
    const unsubscribeExit = client.onExit((payload) => {
      if (payload.sessionId !== sessionId) return;
      if (pending) exited = true;
      else onExitRef.current();
    });

    // Opening measures the character cell, so it waits for the terminal font; a fallback
    // font measured first would size the grid wider than what ends up drawn.
    void whenTerminalFontReady()
      .then(() => {
        if (disposed) throw new Error('disposed');
        term.open(container);
        detachRtl = attachRtlRendering(term);
        if (hasSize()) fitAddon.fit();
      })
      .then(() =>
        client.create({
          sessionId,
          attachOnly: meta.restored,
          cwd: meta.cwd,
          shell: meta.shell,
          initialInput: meta.initialInput,
          projectId: meta.projectId,
          // A hidden pane has no real size yet; leave the shell at whatever it last had.
          ...(hasSize() ? { cols: term.cols, rows: term.rows } : {}),
        }),
      )
      .then((result) => {
        if (disposed) return;
        if (!result) {
          // A restored tab whose shell did not survive (the machine restarted, or it was
          // set to end on quit).
          onExitRef.current();
          return;
        }
        const release = (fromSnapshot: boolean): void => {
          if (disposed) return;
          ptySessionId = result.sessionId;
          const buffered = pending ?? [];
          pending = null;
          for (const chunk of buffered) term.write(chunk);
          if (exited) {
            onExitRef.current();
            return;
          }
          // A painted snapshot is not what ConPTY believes is on screen, so have it repaint.
          if (fromSnapshot && !remote && window.runova.platform === 'win32') {
            resizeSync.repaint();
          } else {
            resizeSync.flush();
          }
        };
        const { snapshot } = result;
        if (!snapshot) {
          release(false);
          return;
        }
        // Repaint at the size the snapshot was taken at, then let the fit reflow it.
        if (snapshot.cols !== term.cols || snapshot.rows !== term.rows) {
          term.resize(snapshot.cols, snapshot.rows);
        }
        term.write(snapshot.data, () => release(true));
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // Remote shells report their own failures (a refused connection); a local shell that
        // never started prints the backend's reason after the familiar line.
        const message =
          remote && error instanceof Error && error.message
            ? error.message
            : describeTerminalStartError(error);
        term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
      });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      resizeSync.dispose();
      stopFontWatch();
      detachContextMenu();
      detachFilePaste();
      detachFocusOnClick();
      detachRtl();
      chipMode?.dispose();
      imagePreview.dispose();
      unsubscribeTheme();
      unsubscribeData();
      unsubscribeExit();
      // The shell is deliberately left running: closing a tab ends it through the store,
      // while an unmount can just as well be a reload that reattaches a moment later. A
      // container console cannot reattach, so it ends with its pane.
      if (meta.kind === 'container' && ptySessionId) void client.kill(ptySessionId);
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Newly opened sessions and tab switches both need to move DOM focus into xterm's hidden
  // textarea. Without it, keystrokes (e.g. Enter to launch, Ctrl+V to paste an install command)
  // go wherever focus already was (often the button that opened this session) instead of the pty.
  // The terminal may not be open yet (it waits for its font), and whatever opened the session can
  // still pull focus away as it closes, so this claims focus for a moment instead of focusing once.
  useEffect(() => {
    const pane = paneRef.current;
    if (!active || !pane) return;
    claimTerminalFocus({
      element: pane,
      canFocus: () => termRef.current?.element !== undefined && pane.clientWidth > 0,
      focus: () => termRef.current?.focus(),
    });
    return () => releaseTerminalFocus(pane);
  }, [active]);

  // The padding lives on the outer box: xterm's fit measures the element it opened in by its
  // CSS size, and with border-box sizing a padded element would report the padding as room.
  return (
    <div ref={paneRef} className={active ? 'terminal-pane absolute inset-0' : 'hidden'}>
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
      {meta.kind === 'ssh' && (
        <SshPasswordButton sessionId={meta.id} onTyped={() => termRef.current?.focus()} />
      )}
    </div>
  );
}
