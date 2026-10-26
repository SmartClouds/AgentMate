import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';

/**
 * React Router's history stamps an `idx` on `window.history.state` for every
 * entry, which is the only way to tell where we sit in the stack. A PUSH
 * truncates anything ahead of it, so the furthest index we've seen since the
 * last push tells us whether "forward" has somewhere to go.
 */
function currentIndex(): number {
  const idx = (window.history.state as { idx?: number } | null)?.idx;
  return typeof idx === 'number' ? idx : 0;
}

export function HistoryNav(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const [{ index, maxIndex }, setStack] = useState(() => {
    const idx = currentIndex();
    return { index: idx, maxIndex: idx };
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: location.key changes on every navigation, which is when the history index has to be re-read
  useEffect(() => {
    const idx = currentIndex();
    setStack((prev) =>
      navigationType === 'PUSH'
        ? { index: idx, maxIndex: idx }
        : { index: idx, maxIndex: Math.max(prev.maxIndex, idx) },
    );
  }, [location.key, navigationType]);

  const canGoBack = index > 0;
  const canGoForward = index < maxIndex;

  const goBack = useCallback(() => {
    if (canGoBack) void navigate(-1);
  }, [canGoBack, navigate]);

  const goForward = useCallback(() => {
    if (canGoForward) void navigate(1);
  }, [canGoForward, navigate]);

  useEffect(() => {
    const isMac = window.runova.platform === 'darwin';

    function onKeyDown(e: KeyboardEvent): void {
      // Alt+Arrow everywhere, plus Cmd+[ / Cmd+] to match macOS conventions.
      const back =
        (e.altKey && e.key === 'ArrowLeft') ||
        (isMac && e.metaKey && (e.code === 'BracketLeft' || e.key === '['));
      const forward =
        (e.altKey && e.key === 'ArrowRight') ||
        (isMac && e.metaKey && (e.code === 'BracketRight' || e.key === ']'));
      if (!back && !forward) return;
      e.preventDefault();
      if (back) goBack();
      else goForward();
    }

    // Mouse thumb buttons (3 = back, 4 = forward), standard on desktop mice.
    function onMouseUp(e: MouseEvent): void {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) goBack();
      else goForward();
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [goBack, goForward]);

  return (
    <div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
      <SimpleTooltip label="Back" side="bottom">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={goBack}
          disabled={!canGoBack}
          aria-label="Go back"
        >
          <ArrowLeft />
        </Button>
      </SimpleTooltip>
      <SimpleTooltip label="Forward" side="bottom">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={goForward}
          disabled={!canGoForward}
          aria-label="Go forward"
        >
          <ArrowRight />
        </Button>
      </SimpleTooltip>
    </div>
  );
}
