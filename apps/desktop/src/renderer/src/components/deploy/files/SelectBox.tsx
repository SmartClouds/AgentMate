import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * The app's checkbox with a third state: a dash for a folder where only some files are ticked.
 * The shared checkbox draws a tick for that state too, which reads as "all of them".
 */
export const SelectBox = forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(function SelectBox({ className, checked, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      checked={checked}
      className={cn(
        'peer flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border-[1.5px] border-foreground/30 bg-foreground/5 transition-colors hover:border-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        {checked === 'indeterminate' ? (
          <svg viewBox="0 0 14 14" fill="none" className="h-2.5 w-2.5" aria-hidden="true">
            <path d="M3.5 7h7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 14 14" fill="none" className="h-2.5 w-2.5" aria-hidden="true">
            <path
              d="M3.2 7.3 5.8 9.9 10.8 4.4"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});
