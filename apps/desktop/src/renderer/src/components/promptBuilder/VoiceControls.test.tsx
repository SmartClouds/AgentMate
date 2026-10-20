// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { VoiceRecordingStrip } from './VoiceControls';

/**
 * The strip a recording shows: a clock, a way to throw the recording away, and level bars that
 * follow the voice. The microphone is a stub that answers with whatever level the test sets.
 */

type Voice = Parameters<typeof VoiceRecordingStrip>[0]['voice'];

function recordingVoice(getLevel: () => number, cancel = vi.fn()): Voice {
  return { status: 'recording', elapsedSeconds: 7, getLevel, cancel } as unknown as Voice;
}

/** The scale each bar is drawn at, oldest first. */
function barScales(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>('div[aria-hidden="true"] > span')].map((bar) =>
    Number(/scaleY\(([\d.]+)\)/.exec(bar.style.transform)?.[1]),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceRecordingStrip', () => {
  it('shows the clock and discards the recording from the button', async () => {
    vi.useRealTimers();
    const cancel = vi.fn();
    const { user } = renderWithProviders(
      <VoiceRecordingStrip voice={recordingVoice(() => 0, cancel)} />,
    );

    expect(screen.getByRole('timer')).toHaveTextContent('0:07');
    await user.click(screen.getByRole('button', { name: 'Discard recording' }));

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rests as a row of dots until someone speaks', async () => {
    const { container } = renderWithProviders(
      <VoiceRecordingStrip voice={recordingVoice(() => 0)} />,
    );

    await act(async () => vi.advanceTimersByTime(300));

    const scales = barScales(container);
    expect(scales.length).toBeGreaterThan(10);
    expect(new Set(scales).size).toBe(1);
    expect(scales[0]).toBeLessThan(0.3);
  });

  it('raises the newest bar with the voice and carries it along to the left', async () => {
    let level = 0;
    const { container } = renderWithProviders(
      <VoiceRecordingStrip voice={recordingVoice(() => level)} />,
    );
    await act(async () => vi.advanceTimersByTime(200));
    const rest = barScales(container).at(-1)!;

    level = 1;
    await act(async () => vi.advanceTimersByTime(120));
    level = 0;
    await act(async () => vi.advanceTimersByTime(120));

    const scales = barScales(container);
    // The loud moment is no longer the newest bar: silence came after it, and the row scrolled.
    expect(scales.at(-1)).toBe(rest);
    expect(Math.max(...scales)).toBeCloseTo(1, 5);
    expect(scales.indexOf(Math.max(...scales))).toBeLessThan(scales.length - 1);
  });

  it('stops reading the microphone once it goes away', async () => {
    const getLevel = vi.fn(() => 0.5);
    const { unmount } = renderWithProviders(
      <VoiceRecordingStrip voice={recordingVoice(getLevel)} />,
    );
    await act(async () => vi.advanceTimersByTime(200));
    unmount();
    getLevel.mockClear();

    await act(async () => vi.advanceTimersByTime(500));

    expect(getLevel).not.toHaveBeenCalled();
  });
});
