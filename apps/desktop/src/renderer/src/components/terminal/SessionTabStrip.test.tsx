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

function renderStrip(activeSessionId = 's1', list = sessions) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const onMove = vi.fn();
  render(
    <TooltipProvider>
      <SessionTabStrip
        sessions={list}
        activeSessionId={activeSessionId}
        onSelect={onSelect}
        onClose={onClose}
        onMove={onMove}
      />
    </TooltipProvider>,
  );
  const tabs = screen.getAllByRole('tab');
  return { onSelect, onClose, onMove, tabs };
}

/**
 * Jsdom has no layout, so a drag has nowhere to go. This puts the tabs on one line, each as wide
 * as the width listed for its place and 2px from the next, the way the strip lays them out.
 */
function layOutTabs(widths: number[]): void {
  const place = (element: HTMLElement): number =>
    Array.from(element.parentElement?.children ?? []).indexOf(element);
  const lefts = widths.map((_, i) => widths.slice(0, i).reduce((sum, w) => sum + w + 2, 0));
  const spy = (property: string, value: (index: number) => number): void => {
    vi.spyOn(HTMLElement.prototype, property as 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return value(place(this));
    });
  };
  spy('offsetLeft', (index) => lefts[index] ?? 0);
  spy('offsetTop', () => 0);
  spy('offsetWidth', (index) => widths[index] ?? 0);
  spy('offsetHeight', () => 28);
}

/** Presses a tab, moves the pointer `distance` px along the strip and lets go. */
function dragTab(tab: HTMLElement, distance: number): void {
  fireEvent.pointerDown(tab, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(tab, { clientX: distance, clientY: 0, pointerId: 1 });
  fireEvent.pointerUp(tab, { pointerId: 1 });
}

afterEach(() => {
  // A drag that travelled leaves a one-shot click swallower on the window for 300ms. Spend it, or
  // it eats the first click of whichever test runs next.
  window.dispatchEvent(new MouseEvent('click'));
  vi.restoreAllMocks();
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

describe('SessionTabStrip reordering', () => {
  // PowerShell is 90px wide and Command Prompt 130px, with 2px between them.
  const widths = [90, 130];

  it('moves a tab left when it is dragged over the one before it', () => {
    layOutTabs(widths);
    const { tabs, onMove, onSelect } = renderStrip();
    dragTab(tabs[1], -60);

    expect(onMove.mock.calls).toEqual([[1, 0]]);
    // The drag ends on the tab it started on, and the click that follows must not switch to it.
    fireEvent.click(tabs[1]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('moves a tab right when it is dragged over the one after it', () => {
    layOutTabs(widths);
    const { tabs, onMove } = renderStrip();
    dragTab(tabs[0], 80);
    expect(onMove.mock.calls).toEqual([[0, 1]]);
  });

  it('slides the tab it passes aside by the width of the tab held, and lifts the held one', () => {
    layOutTabs(widths);
    const { tabs } = renderStrip();
    fireEvent.pointerDown(tabs[1], { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    // A press is not yet a drag: the tab only looks held once the pointer has really moved.
    expect(tabs[1].className).not.toContain('bg-popover');
    fireEvent.pointerMove(tabs[1], { clientX: -60, clientY: 0, pointerId: 1 });

    expect(tabs[1].style.transform).toBe('translate(-60px, 0px)');
    expect(tabs[1].className).toContain('bg-popover');
    expect(tabs[1].className).toContain('transition-none');
    // PowerShell makes room for the 130px tab and the 2px gap.
    expect(tabs[0].style.transform).toBe('translate(132px, 0px)');
    expect(tabs[0].className).toContain('duration-200');

    fireEvent.pointerUp(tabs[1], { pointerId: 1 });
    expect(tabs[1].className).not.toContain('bg-popover');
  });

  it('makes room by the width of the tab held when the tabs are different widths', () => {
    layOutTabs([90, 130, 70]);
    const third: TerminalSessionMeta = { id: 's3', kind: 'local', title: 'bash' };
    const { tabs, onMove } = renderStrip('s1', [...sessions, third]);
    // Dragged right as far as it goes: the 90px tab passes both, and each steps left by 92.
    fireEvent.pointerDown(tabs[0], { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(tabs[0], { clientX: 400, clientY: 0, pointerId: 1 });
    expect(tabs[1].style.transform).toBe('translate(-92px, 0px)');
    expect(tabs[2].style.transform).toBe('translate(-92px, 0px)');
    fireEvent.pointerUp(tabs[0], { pointerId: 1 });
    expect(onMove.mock.calls).toEqual([[0, 2]]);
  });

  it('still switches on a plain click, and moves nothing', () => {
    layOutTabs(widths);
    const { tabs, onMove, onSelect } = renderStrip();
    fireEvent.pointerDown(tabs[1], { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(tabs[1], { pointerId: 1 });
    fireEvent.click(tabs[1]);

    expect(onSelect.mock.calls).toEqual([['s2']]);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('leaves a tab where it was when it is dropped back on its own place', () => {
    layOutTabs(widths);
    const { tabs, onMove } = renderStrip();
    dragTab(tabs[1], -10);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('does not start a drag from the close button', () => {
    layOutTabs(widths);
    const { onMove, onClose, onSelect } = renderStrip();
    const close = screen.getByRole('button', { name: 'Close Command Prompt' });
    fireEvent.pointerDown(close, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(close, { clientX: -80, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(close, { pointerId: 1 });
    fireEvent.click(close);

    expect(onMove).not.toHaveBeenCalled();
    expect(onClose.mock.calls).toEqual([['s2']]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('has nothing to reorder with a single tab', () => {
    layOutTabs([90]);
    const { tabs, onMove } = renderStrip('s1', [sessions[0] as TerminalSessionMeta]);
    dragTab(tabs[0], 50);
    expect(onMove).not.toHaveBeenCalled();
    expect(tabs[0].style.transform).toBe('');
  });

  it('ignores a drag with a button other than the main one', () => {
    layOutTabs(widths);
    const { tabs, onMove } = renderStrip();
    fireEvent.pointerDown(tabs[1], { button: 1, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(tabs[1], { clientX: -80, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(tabs[1], { pointerId: 1 });
    expect(onMove).not.toHaveBeenCalled();
  });
});
