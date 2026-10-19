import { siWordpress } from 'simple-icons';
import { cn } from '@/lib/utils';

/**
 * WordPress's own mark, for WordPress sites in Deploy and WordPress projects. It is brand blue
 * unless a `fill` is passed, such as `currentColor` to take the text color around it.
 */
export function WordPressMark({
  className,
  fill = `#${siWordpress.hex}`,
}: {
  className?: string;
  fill?: string;
}): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill={fill} className={cn('shrink-0', className)}>
      <path d={siWordpress.path} />
    </svg>
  );
}
