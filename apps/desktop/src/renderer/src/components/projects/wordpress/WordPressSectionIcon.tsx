import { forwardRef } from 'react';
import type { IconProps } from '@/components/icons';
import { WordPressMark } from '@/components/wordpress/WordPressMark';

/**
 * WordPress's mark shaped like the app's other icons (a forwarded-ref component taking
 * `className`), so it can sit in the project section nav next to them. It is drawn in the nav's
 * text color rather than brand blue, so the selected and hover states color it like the others.
 */
export const WordPressSectionIcon = forwardRef<SVGSVGElement, IconProps>(({ className }, _ref) => (
  <WordPressMark className={className} fill="currentColor" />
));
WordPressSectionIcon.displayName = 'WordPressSectionIcon';
