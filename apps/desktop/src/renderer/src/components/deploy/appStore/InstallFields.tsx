import type { AnyCatalogTemplate, CatalogSecretSpec } from '@runova/core';
import { useId } from 'react';
import { toast } from 'sonner';
import { Copy, Key, RefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SimpleTooltip } from '@/components/ui/tooltip';
import type { InstallDraft } from '@/lib/deploy/appStore/draft';
import { FieldError, TextField, ToggleRow } from '../sites/fields';

/** The parts of the install sheet: the app's settings, its passwords and its domain. */

export function ParamFields({
  template,
  values,
  problems,
  onChange,
}: {
  template: AnyCatalogTemplate;
  values: InstallDraft['values'];
  problems: Record<string, string>;
  onChange: (key: string, value: string | boolean) => void;
}): React.JSX.Element | null {
  const entries = Object.entries(template.fields);
  if (entries.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {entries.map(([key, field]) =>
        field.input === 'toggle' ? (
          <div key={key} className="sm:col-span-2">
            <ToggleRow
              label={field.label}
              description={field.help}
              checked={values[key] === true}
              onChange={(checked) => onChange(key, checked)}
            />
          </div>
        ) : (
          <TextField
            key={key}
            label={field.label}
            value={typeof values[key] === 'string' ? (values[key] as string) : ''}
            onChange={(value) => onChange(key, value)}
            hint={field.help}
            error={problems[key]}
            inputMode={field.input === 'text' ? 'text' : 'numeric'}
            mono={field.input !== 'text'}
          />
        ),
      )}
    </div>
  );
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}.`);
  }
}

function SecretRow({
  spec,
  value,
  problem,
  onChange,
  onRegenerate,
}: {
  spec: CatalogSecretSpec;
  value: string;
  problem?: string;
  onChange: (value: string) => void;
  onRegenerate: () => void;
}): React.JSX.Element {
  const id = useId();
  return (
    <li className="space-y-1">
      <Label htmlFor={id} className="flex items-center gap-1.5">
        <Key className="h-3 w-3 text-muted-foreground" /> {spec.label}
        <span className="font-mono text-[11px] font-normal text-muted-foreground">{spec.key}</span>
      </Label>
      <div className="flex items-center gap-1">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={problem ? true : undefined}
          className="h-8 font-mono text-xs"
        />
        <SimpleTooltip label={`Copy ${spec.label.toLowerCase()}`}>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Copy ${spec.label}`}
            onClick={() => void copy(value, spec.label)}
          >
            <Copy />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Make a new one">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Make a new ${spec.label}`}
            onClick={onRegenerate}
          >
            <RefreshCw />
          </Button>
        </SimpleTooltip>
      </div>
      <FieldError message={problem} />
    </li>
  );
}

export function SecretRows({
  specs,
  secrets,
  problems,
  onChange,
  onRegenerate,
}: {
  specs: readonly CatalogSecretSpec[];
  secrets: Record<string, string>;
  problems: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onRegenerate: (spec: CatalogSecretSpec) => void;
}): React.JSX.Element | null {
  if (specs.length === 0) return null;
  return (
    <section aria-label="Generated passwords" className="space-y-2">
      <div>
        <h4 className="text-sm font-medium">Passwords</h4>
        <p className="text-xs text-muted-foreground">
          Made on this computer for this install only. This is the one time they are shown in full,
          so copy what you need now. Later an Admin can reveal them from the app's card.
        </p>
      </div>
      <ul className="space-y-2">
        {specs.map((spec) => (
          <SecretRow
            key={spec.key}
            spec={spec}
            value={secrets[spec.key] ?? ''}
            problem={problems[spec.key]}
            onChange={(value) => onChange(spec.key, value)}
            onRegenerate={() => onRegenerate(spec)}
          />
        ))}
      </ul>
    </section>
  );
}

export function ExposeFields({
  template,
  web,
  draft,
  problems,
  canAdmin,
  onChange,
}: {
  template: AnyCatalogTemplate;
  /** The app has a web interface the proxy can point at. */
  web: boolean;
  draft: InstallDraft;
  problems: Record<string, string>;
  canAdmin: boolean;
  onChange: (next: Partial<InstallDraft>) => void;
}): React.JSX.Element {
  const certificateId = useId();
  const reason = !web
    ? (template.exposureNote ?? 'This app has no web interface to put on a domain.')
    : !canAdmin
      ? 'Adding a website needs the Admin role. The app stays on 127.0.0.1 until an Admin puts it on a domain in Websites.'
      : undefined;
  return (
    <section aria-label="On a domain" className="space-y-1">
      <ToggleRow
        label="Put it on a domain"
        description="Adds a site in Websites that forwards the domain to the app, which keeps listening on 127.0.0.1 only."
        checked={draft.expose}
        onChange={(expose) => onChange({ expose })}
        disabled={!canAdmin || !web}
        disabledReason={reason}
      />
      {web && template.exposureNote && (
        <p className="text-xs text-muted-foreground">{template.exposureNote}</p>
      )}
      {web && draft.expose && (
        <div className="space-y-2 pl-0.5">
          <TextField
            label="Domain"
            value={draft.domain}
            onChange={(domain) => onChange({ domain })}
            placeholder="app.example.com"
            hint="Point its DNS at this server first, so the certificate can be issued."
            error={problems.domain}
            mono
          />
          <div className="flex items-start gap-2">
            <Checkbox
              id={certificateId}
              checked={draft.certificate}
              onCheckedChange={(checked) => onChange({ certificate: checked === true })}
              className="mt-px"
            />
            <Label
              htmlFor={certificateId}
              className="cursor-pointer text-xs font-normal leading-snug text-muted-foreground"
            >
              Get a free certificate from Let's Encrypt for HTTPS. Asking for one accepts Let's
              Encrypt's terms of service.
            </Label>
          </div>
        </div>
      )}
    </section>
  );
}
