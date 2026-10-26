import { DEFAULT_TERMINAL_BACKGROUND_COLOR, normalizeProjectColor } from '@runova/core';
import { create } from 'zustand';

interface TerminalAppearanceState {
  /** Off means a Workspace terminal pane looks the way its CLI would in any ordinary terminal. */
  customBackground: boolean;
  /** Used for Workspace terminal panes when `customBackground` is on. */
  backgroundColor: string;
  setCustomBackground: (enabled: boolean) => void;
  setBackgroundColor: (color: string) => void;
}

export const useTerminalAppearanceStore = create<TerminalAppearanceState>((set) => ({
  customBackground: false,
  backgroundColor: DEFAULT_TERMINAL_BACKGROUND_COLOR,
  setCustomBackground: (enabled) => {
    set({ customBackground: enabled });
    void window.runova.settings.update({ workspaceTerminalCustomBackground: enabled });
  },
  setBackgroundColor: (color) => {
    const hex = normalizeProjectColor(color) ?? DEFAULT_TERMINAL_BACKGROUND_COLOR;
    set({ backgroundColor: hex });
    void window.runova.settings.update({ workspaceTerminalBackgroundColor: hex });
  },
}));

export async function initTerminalAppearance(): Promise<void> {
  const settings = await window.runova.settings.get();
  useTerminalAppearanceStore.setState({
    customBackground: settings.workspaceTerminalCustomBackground,
    backgroundColor: settings.workspaceTerminalBackgroundColor,
  });
}
