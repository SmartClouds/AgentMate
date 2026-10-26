import { useLayoutEffect, useRef, useState } from 'react';
import { pathsToChips } from '@/lib/terminal/pasteFiles';
import { terminalRuntime } from '@/lib/terminal/terminalRuntime';
import { resolveWorkspaceTerminalTheme } from '@/lib/terminal/xtermFactory';
import { rememberAgentTab } from '@/lib/workspace/agentTarget';
import { useTerminalAppearanceStore } from '@/stores/terminalAppearanceStore';
import { useThemeStore } from '@/stores/themeStore';
import type { WorkspaceTerminalTab } from '@/stores/workspaceStore';

export interface TerminalSlotProps {
  projectId: string;
  tab: WorkspaceTerminalTab;
  /** Pulls keyboard focus into the terminal when it becomes the focused pane's active tab. */
  focused: boolean;
}

function isFileDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes('Files');
}

/** The on-screen spot a workspace terminal renders into. The terminal itself lives in the runtime. */
export function TerminalSlot({ projectId, tab, focused }: TerminalSlotProps): React.JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  const customBackground = useTerminalAppearanceStore((s) => s.customBackground);
  const backgroundColor = useTerminalAppearanceStore((s) => s.backgroundColor);
  const theme = useThemeStore((s) => s.theme);
  const { wellBackground } = resolveWorkspaceTerminalTheme(
    { customBackground, backgroundColor },
    theme,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the runtime keys everything by session id; launch settings only matter the first time a session starts
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    terminalRuntime.mount(
      {
        id: tab.id,
        projectId,
        cwd: tab.cwd,
        shell: tab.shell,
        cliId: tab.cliId,
        initialInput: tab.launchInput,
        restored: tab.restored,
      },
      slot,
    );
    return () => terminalRuntime.unmount(tab.id, slot);
  }, [tab.id]);

  useLayoutEffect(() => {
    if (focused) terminalRuntime.focus(tab.id);
  }, [focused, tab.id]);

  return (
    <div
      className="absolute inset-0"
      onFocusCapture={() => {
        if (tab.cliId) rememberAgentTab(projectId, tab.id);
      }}
      onDragOver={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(event) => {
        setDropping(false);
        if (!isFileDrag(event)) return;
        event.preventDefault();
        // Dropped files become quoted paths at the prompt, the way a native terminal does it.
        const paths = Array.from(event.dataTransfer.files)
          .map((file) => window.runova.shell.pathForFile(file))
          .filter((path): path is string => Boolean(path));
        if (paths.length === 0) return;
        terminalRuntime.pasteChips(tab.id, pathsToChips(paths, tab.shell));
        terminalRuntime.focus(tab.id);
      }}
    >
      <div
        ref={slotRef}
        className="terminal-well absolute inset-0"
        style={{ '--terminal-bg': wellBackground } as React.CSSProperties}
      />
      {dropping ? (
        // A dashed outline, since the global border colour would grey out a dashed border.
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl bg-primary/[0.07] text-xs font-medium text-primary outline-2 -outline-offset-2 outline-dashed outline-primary/60">
          Drop to paste the file path
        </div>
      ) : null}
    </div>
  );
}
