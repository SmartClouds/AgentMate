import { SectionCard } from '@/components/pageKit';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** Form pieces the Cloudflare dialog shares, in the look of the app's own inputs. */

export function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The kit's notice and card under the names the Cloudflare dialog has always used. A Cloudflare
 * card is flush: its parts pad themselves, so tables and hairline rows can run edge to edge.
 */
export {
  Notice,
  type NoticeTone,
  Problem,
  SectionCardBody as CardBody,
} from '@/components/pageKit';

export function CloudflareCard({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SectionCard>, 'flush' | 'bodyClassName'>): React.JSX.Element {
  return (
    <SectionCard flush className={cn('flex min-w-0 flex-col', className)} {...props}>
      {children}
    </SectionCard>
  );
}
