import { Checkbox } from '@/components/ui/checkbox';

/**
 * The opt-in under a password field that asks for the core password again: have this computer
 * keep it, sealed, so the next confirmation does not ask.
 */
export function RememberPasswordOption({
  id,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm" htmlFor={id}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <span>
        Remember my password on this computer
        <span className="block text-xs text-muted-foreground">
          It is kept sealed in the Servers vault and answers this question for you. Signing out of
          the server forgets it.
        </span>
      </span>
    </label>
  );
}
