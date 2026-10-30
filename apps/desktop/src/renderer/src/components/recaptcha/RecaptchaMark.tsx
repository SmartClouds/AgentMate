import { Shield } from '@/components/icons';
import { cn } from '@/lib/utils';

/** The reCAPTCHA page's mark, for its header and the way in from Deploy. */
export function RecaptchaMark({ className }: { className?: string }): React.JSX.Element {
  return <Shield aria-hidden="true" className={cn('shrink-0 text-[#4a8af4]', className)} />;
}
