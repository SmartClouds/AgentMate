// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useRunPauseStore } from '@/stores/runPauseStore';
import type { TerminalSessionMeta } from '@/stores/terminalStore';
import { SessionTabStrip } from './TerminalDrawer';

/**
 * The drawer's tab strip. A tab once only switched when the click landed on its label: the
 * padding around it and the space beside the close button looked like part of the tab (they
 * highlight on hover) but did nothing, so switching often took a second click.
 */

const sessions: TerminalSessionMeta[] = [
  { id: 's1', kind: 'local', title: 'PowerShell' },
  { id: 's2', kind: 'local', title: 'Command Prompt' },
];

function renderStrip(activeSessionId = 's1') {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <TooltipProvider>
      <SessionTabStrip
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={onSelect}
        onClose={onClose}
      />
    </TooltipProvider>,
  );
  const tabs = screen.getAllByRole('tab');
  return { onSelect, onClose, tabs };
}

afterEach(() => {
  cleanup();
  useRunPauseStore.setState({ paused: {}, pending: {} });
});

describe('SessionTabStrip', () => {
  it('makes the whole highlighted box the tab, not just its label', () => {
    const { tabs } = renderStrip();
    expect(tabs).toHaveLength(2);
    // The element that carries the padding and the hover highlight is the tab itself.
    for (const tab of tabs) {
      expect(tab.className).toContain('px-2.5');
      expect(tab.querySelector('button[aria-label^="Close "]')).not.toBeNull();
    }
    expect(tabs[1].className).toContain('hover:bg-foreground/[0.05]');
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  });

  it('switches on a click anywhere on the tab, including its padding', () => {
    const { onSelect } = renderStrip();
    // A click on the padding lands on the box that draws it, not on anything inside it.
    const box = screen.getByText('Command Prompt').closest<HTMLElement>('.px-2\\.5');
    expect(box).not.toBeNull();
    fireEvent.click(box as HTMLElement);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith('s2');

    fireEvent.click(screen.getByText('Command Prompt'));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith('s2');
  });

  it('marks a paused run on its tab, also for screen readers', () => {
    useRunPauseStore.setState({ paused: { s2: { reason: 'user', pausedAt: 1 } }, pending: {} });
    const { tabs } = renderStrip();

    expect(tabs[1].querySelector('[data-paused]')).not.toBeNull();
    expect(tabs[1]).toHaveAccessibleName(/Command Prompt.*paused/);
    expect(tabs[0].querySelector('[data-paused]')).toBeNull();
  });

  it('switches from the keyboard', () => {
    const { tabs, onSelect } = renderStrip();
    fireEvent.keyDown(tabs[1], { key: 'Enter' });
    fireEvent.keyDown(tabs[1], { key: ' ' });
    expect(onSelect.mock.calls).toEqual([['s2'], ['s2']]);
  });

  it('closes from the close button without also switching to that tab', () => {
    const { onSelect, onClose } = renderStrip();
    const close = screen.getByRole('button', { name: 'Close Command Prompt' });
    fireEvent.click(close);
    fireEvent.keyDown(close, { key: 'Enter' });
    expect(onClose.mock.calls).toEqual([['s2']]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('closes a tab on a middle click anywhere on it', () => {
    const { tabs, onSelect, onClose } = renderStrip();
    fireEvent(tabs[1], new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(onClose.mock.calls).toEqual([['s2']]);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
