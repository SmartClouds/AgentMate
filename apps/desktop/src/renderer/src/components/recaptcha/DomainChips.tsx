import { MAX_DOMAINS, parseDomainList } from '@shared/recaptcha/domains';
import { useId, useState } from 'react';
import { X } from '@/components/icons';
import { FIELD_SURFACE, Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const LOCALHOST = 'localhost';

/** "a.com", "a.com and b.com", "a.com, b.com and c.com". */
function joinNames(names: string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The domains a key (or a Turnstile widget) works on, as chips in one field. Typing a domain and pressing Enter, a comma
 * or a space adds it, and so does leaving the field; a pasted list or URL is split and trimmed to
 * bare domains. What cannot be used is listed under the field with the reason. `localhost` has a
 * switch of its own, since it is for testing and easy to forget to take off; `localhostSwitch`
 * off makes it a chip like any other. Below `max` the field counts what is left.
 */
export function DomainChips({
  id,
  domains,
  onChange,
  invalid,
  max = MAX_DOMAINS,
  localhostSwitch = true,
}: {
  id: string;
  domains: string[];
  onChange: (domains: string[]) => void;
  invalid?: boolean;
  max?: number;
  localhostSwitch?: boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [problems, setProblems] = useState<{ input: string; reason: string }[]>([]);
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const localhostId = useId();
  const hintId = useId();
  const shown = localhostSwitch ? domains.filter((domain) => domain !== LOCALHOST) : domains;
  const localhost = domains.includes(LOCALHOST);

  function add(text: string): void {
    const parsed = parseDomainList(text);
    setProblems(parsed.invalid);
    const next = [...domains];
    for (const domain of parsed.domains) if (!next.includes(domain)) next.push(domain);
    setLeftOut(next.slice(max));
    if (next.length !== domains.length) onChange(next.slice(0, max));
  }

  function commit(): void {
    if (!draft.trim()) return;
    add(draft);
    setDraft('');
  }

  return (
    <div className="space-y-2">
      <div
        className={cn(
          FIELD_SURFACE,
          'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-2xl px-2 py-1.5',
        )}
        aria-invalid={invalid || undefined}
      >
        {shown.map((domain) => (
          <span
            key={domain}
            className="inline-flex h-6 items-center gap-1 rounded-full bg-primary/12 pl-2.5 pr-1 font-mono text-xs text-primary"
          >
            {domain}
            <button
              type="button"
              aria-label={`Remove ${domain}`}
              onClick={() => onChange(domains.filter((one) => one !== domain))}
              className="flex h-4 w-4 items-center justify-center rounded-full outline-none hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-2.5 [&_svg]:w-2.5"
            >
              <X />
            </button>
          </span>
        ))}
        <Input
          id={id}
          variant="bare"
          aria-label="Domains"
          aria-describedby={hintId}
          value={draft}
          placeholder={shown.length === 0 ? 'example.com, www.example.com' : 'Add another'}
          className="h-6 min-w-[10rem] flex-1 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
          onChange={(event) => {
            const value = event.target.value;
            // A separator typed at the end finishes the domain before it.
            if (/[\s,;]$/.test(value)) {
              add(value);
              setDraft('');
            } else {
              setDraft(value);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Backspace' && draft === '' && shown.length > 0) {
              const last = shown[shown.length - 1];
              onChange(domains.filter((one) => one !== last));
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            add(`${draft} ${event.clipboardData.getData('text')}`);
            setDraft('');
          }}
          onBlur={commit}
        />
      </div>
      {leftOut.length > 0 && (
        <p className="text-xs text-warning" aria-live="polite">
          Only {max} domains fit, so {joinNames(leftOut)} {leftOut.length === 1 ? 'was' : 'were'}{' '}
          left out.
        </p>
      )}
      {problems.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive" aria-live="polite">
          {problems.map((problem) => (
            <li key={problem.input}>
              {problem.input}: {problem.reason}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={hintId} className="text-xs text-muted-foreground">
          Subdomains of each domain work too, so shop.com covers www.shop.com.
        </p>
        {max < MAX_DOMAINS && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {domains.length} of {max}
          </span>
        )}
        {localhostSwitch && (
          <label
            htmlFor={localhostId}
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <Switch
              id={localhostId}
              aria-label="Allow localhost for testing"
              checked={localhost}
              onCheckedChange={(on) =>
                onChange(on ? [...domains, LOCALHOST] : domains.filter((one) => one !== LOCALHOST))
              }
            />
            Allow localhost for testing
          </label>
        )}
      </div>
    </div>
  );
}
