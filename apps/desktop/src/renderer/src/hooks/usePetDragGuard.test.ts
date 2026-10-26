import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { usePetDragGuard } from './usePetDragGuard';

/**
 * The desktop companion is a click-through overlay that still swallows native drops, so a drag
 * has to park it. Getting the release wrong is what leaves the pet stuck out of the way, which
 * is what these tests are really watching for.
 */

function fire(type: 'dragstart' | 'dragend' | 'drop'): void {
  act(() => {
    document.dispatchEvent(new Event(type, { bubbles: true }));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('usePetDragGuard', () => {
  it('does nothing until a drag actually starts', () => {
    const bridge = installRunovaBridge();
    renderHook(() => usePetDragGuard());
    expect(() => bridge.$fn('pet.setDragGuard')).toThrow();
  });

  it('parks the companion for the length of a drag', () => {
    const bridge = installRunovaBridge();
    renderHook(() => usePetDragGuard());

    fire('dragstart');
    expect(bridge.$fn('pet.setDragGuard')).toHaveBeenLastCalledWith(true);

    fire('dragend');
    expect(bridge.$fn('pet.setDragGuard')).toHaveBeenLastCalledWith(false);
    expect(bridge.$fn('pet.setDragGuard')).toHaveBeenCalledTimes(2);
  });

  it('releases on a drop as well, since a dropped drag never fires dragend everywhere', () => {
    const bridge = installRunovaBridge();
    renderHook(() => usePetDragGuard());

    fire('dragstart');
    fire('drop');
    expect(bridge.$fn('pet.setDragGuard')).toHaveBeenLastCalledWith(false);
  });

  // Nested drag sources fire dragstart more than once; the overlay should be parked once.
  it('holds once for a run of dragstart events', () => {
    const bridge = installRunovaBridge();
    renderHook(() => usePetDragGuard());

    fire('dragstart');
    fire('dragstart');
    fire('dragstart');
    expect(bridge.$fn('pet.setDragGuard')).toHaveBeenCalledTimes(1);
  });

  it('lets go on its own when a drag never ends', () => {
    vi.useFakeTimers();
    const bridge = installRunovaBridge();
    renderHook(() => usePetDragGuard());

    fire('dragstart');
    act(() => {
      vi.advanceTimersByTime(29_999);
    });
    expect(bridge.$fn('pet.setDragGuard')).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(bridge.$fn('pet.setDragGuard')).toHaveBeenLastCalledWith(false);
  });

  it('releases and stops listening when the component unmounts mid-drag', () => {
    const bridge = installRunovaBridge();
    const { unmount } = renderHook(() => usePetDragGuard());

    fire('dragstart');
    unmount();
    expect(bridge.$fn('pet.setDragGuard')).toHaveBeenLastCalledWith(false);

    const callsAfterUnmount = bridge.$fn('pet.setDragGuard').mock.calls.length;
    fire('dragstart');
    expect(bridge.$fn('pet.setDragGuard')).toHaveBeenCalledTimes(callsAfterUnmount);
  });
});
