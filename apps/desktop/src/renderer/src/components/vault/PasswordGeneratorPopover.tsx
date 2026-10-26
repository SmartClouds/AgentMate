import {
  generatedEntropy,
  generatePassword,
  PASSWORD_LENGTH_MAX,
  PASSWORD_LENGTH_MIN,
  type PasswordOptions,
} from '@runova/core';
import { useId, useState } from 'react';
import { Dice, RefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useVaultStore } from '@/stores/vaultStore';
import { PasswordStrengthMeter } from './PasswordStrengthMeter';
import { SecretText } from './SecretText';

type SetKey = 'uppercase' | 'lowercase' | 'digits' | 'symbols';

const SETS: { key: SetKey; short: string; label: string }[] = [
  { key: 'uppercase', short: 'A-Z', label: 'Uppercase letters' },
  { key: 'lowercase', short: 'a-z', label: 'Lowercase letters' },
  { key: 'digits', short: '0-9', label: 'Digits' },
  { key: 'symbols', short: '!#$', label: 'Symbols' },
];

// The slider tops out lower than the generator allows: past 64 nobody drags, they type.
const SLIDER_MAX = Math.min(64, PASSWORD_LENGTH_MAX);

export function PasswordGeneratorPopover({
  onUse,
}: {
  onUse: (password: string) => void;
}): React.JSX.Element {
  const options = useVaultStore((s) => s.generator);
  const setOptions = useVaultStore((s) => s.setGenerator);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const lookAlikeId = useId();

  function update(next: PasswordOptions): void {
    setOptions(next);
    setPassword(generatePassword(next));
  }

  function handleOpenChange(next: boolean): void {
    if (next) setPassword(generatePassword(options));
    setOpen(next);
  }

  const enabledSets = SETS.filter((set) => options[set.key]).length;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <SimpleTooltip label="Generate a password">
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Generate a password">
            <Dice className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
      </SimpleTooltip>
      <PopoverContent className="w-80 space-y-3" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="flex items-start gap-2 rounded-md border border-border/70 bg-background/60 px-3 py-2.5">
          <SecretText
            value={password}
            testId="generated-password"
            className="min-h-[1.5rem] flex-1 text-[15px] leading-6"
          />
          <SimpleTooltip label="Generate another">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="-mr-1.5 -mt-1 shrink-0"
              aria-label="Generate another"
              onClick={() => setPassword(generatePassword(options))}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </SimpleTooltip>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Length</span>
            <span className="font-medium tabular-nums">{options.length}</span>
          </div>
          <input
            type="range"
            aria-label="Length"
            min={PASSWORD_LENGTH_MIN}
            max={SLIDER_MAX}
            value={Math.min(options.length, SLIDER_MAX)}
            onChange={(event) => update({ ...options, length: Number(event.target.value) })}
            className="w-full accent-[hsl(var(--primary))]"
          />
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {SETS.map((set) => {
            const isLastOn = options[set.key] && enabledSets === 1;
            return (
              <SimpleTooltip
                key={set.key}
                label={isLastOn ? 'Keep at least one set of characters' : null}
                wrapTrigger
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs">{set.short}</span>
                  <Switch
                    aria-label={set.label}
                    checked={options[set.key]}
                    disabled={isLastOn}
                    onCheckedChange={(checked) => update({ ...options, [set.key]: checked })}
                  />
                </div>
              </SimpleTooltip>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id={lookAlikeId}
            checked={options.avoidAmbiguous}
            onCheckedChange={(checked) => update({ ...options, avoidAmbiguous: checked === true })}
          />
          <Label htmlFor={lookAlikeId} className="text-xs font-normal">
            Avoid look-alike characters
          </Label>
        </div>

        <PasswordStrengthMeter password={password} bits={generatedEntropy(options)} />

        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              onUse(password);
              setOpen(false);
            }}
          >
            Use password
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
