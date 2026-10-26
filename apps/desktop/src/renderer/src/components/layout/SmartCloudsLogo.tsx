import logo2x from '@/assets/smartclouds-logo@2x.webp';
import logo1x from '@/assets/smartclouds-logo.webp';
import { cn } from '@/lib/utils';

/*
 * The logo files come from the SmartClouds website: 60x32 at 1x and 120x64 at 2x. "lg" is the
 * 1x size itself, so it is pixel-exact on standard and HiDPI screens alike. "md" keeps the same
 * 15:8 shape at a size that credits the maker in the About dialog without competing with the
 * Runova icon above it.
 */
const SIZES = {
  md: { width: 45, height: 24 },
  lg: { width: 60, height: 32 },
} as const;

/**
 * The SmartClouds cloud logo. It is white and grey, so on the light theme the caller has to
 * keep it visible, for example with a drop-shadow that traces its edge (see AboutDialog).
 */
export function SmartCloudsLogo({
  size,
  alt = '',
  className,
}: {
  size: keyof typeof SIZES;
  /** Empty when the logo sits next to text that already names the company. */
  alt?: string;
  className?: string;
}): React.JSX.Element {
  const { width, height } = SIZES[size];
  return (
    <img
      src={logo1x}
      srcSet={`${logo1x} 1x, ${logo2x} 2x`}
      width={width}
      height={height}
      alt={alt}
      decoding="async"
      draggable={false}
      className={cn('select-none', className)}
    />
  );
}
