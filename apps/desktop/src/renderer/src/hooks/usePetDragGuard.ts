import { useEffect } from 'react';

/**
 * A drag that never ends (the source card unmounted mid-drag, the window lost
 * the drop) would otherwise keep the companion parked, so let go anyway.
 */
const RELEASE_AFTER_MS = 30_000;

/**
 * Keeps the desktop companion out of the way while the app runs a native drag.
 *
 * The companion is a full screen click-through window sitting on top of
 * everything. Clicks fall through it, but Windows still hands it the drop when
 * a drag ends over it, which is why reordering projects or dashboard cards did
 * nothing at all until the pet was switched off. Main parks the overlay for as
 * long as a drag is running, and this is what tells it when that is.
 */
export function usePetDragGuard(): void {
  useEffect(() => {
    let held = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function release(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!held) return;
      held = false;
      window.runova.pet.setDragGuard(false);
    }

    function hold(): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(release, RELEASE_AFTER_MS);
      if (held) return;
      held = true;
      window.runova.pet.setDragGuard(true);
    }

    // Capture phase so a handler that stops the event still gets us the signal.
    document.addEventListener('dragstart', hold, true);
    document.addEventListener('dragend', release, true);
    document.addEventListener('drop', release, true);
    return () => {
      document.removeEventListener('dragstart', hold, true);
      document.removeEventListener('dragend', release, true);
      document.removeEventListener('drop', release, true);
      release();
    };
  }, []);
}
