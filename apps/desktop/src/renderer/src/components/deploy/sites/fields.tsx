import { useId } from 'react';
import { TriangleAlert } from '@/components/icons';
import { SECTION_WELL } from '@/components/pageKit';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/** The small form pieces every tab of the site editor is made of. */

/** A problem with a field, marked with an icon and announced, not only coloured. */
export function FieldError({
  id,
  message,
}: {
  id?: string;
  message?: string;
}): React.JSX.Element | null {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
      <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  disabledReason,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Said under the switch while it is off limits, such as "Needs a certificate first." */
  disabledReason?: string;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className={cn(disabled && 'text-muted-foreground')}>
          {label}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
        {disabled && disabledReason && (
          <p className="text-xs text-muted-foreground">{disabledReason}</p>
        )}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  disabled,
  suffix,
  className,
  inputMode,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  /** A unit after the box, such as "seconds". */
  suffix?: string;
  className?: string;
  inputMode?: 'numeric' | 'text' | 'email' | 'url';
  mono?: boolean;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          inputMode={inputMode}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={cn(mono && 'font-mono')}
        />
        {suffix && <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>}
      </div>
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/** A titled group of fields inside a tab. */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={cn(SECTION_WELL, 'space-y-3 p-4')}>
      <div className="space-y-0.5">
        <h4 className="text-[13px] font-semibold text-foreground">{title}</h4>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}
