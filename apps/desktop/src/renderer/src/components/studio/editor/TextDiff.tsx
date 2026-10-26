import { Suspense, useEffect, useState } from 'react';
import { MonacoDiffEditor, Skeleton } from '../kit';

/**
 * Two texts side by side in Monaco's diff view, read-only. Monaco is mounted two frames after the
 * dialog opens, once the dialog has its size, which a freshly opened dialog does not have yet.
 */
export function TextDiff({
  path,
  original,
  modified,
  className,
}: {
  /** Picks the highlighting: `scene.js`, `request.md`. */
  path: string;
  original: string;
  modified: string;
  className?: string;
}): React.JSX.Element {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setReady(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);
  const shimmer = <Skeleton className={className ?? 'h-80 w-full'} />;
  if (!ready) return shimmer;
  return (
    <Suspense fallback={shimmer}>
      <MonacoDiffEditor
        path={path}
        original={original}
        modified={modified}
        sideBySide
        ignoreWhitespace={false}
        className={className ?? 'h-80 w-full'}
      />
    </Suspense>
  );
}
