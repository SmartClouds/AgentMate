import type {
  SiteFrameOptions,
  SiteRatePeriod,
  SiteReferrerPolicy,
} from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { useId } from 'react';
import { Plus, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { AccessFields } from './AccessFields';
import { FieldError, Section, TextField, ToggleRow } from './fields';
import type { SiteTabProps } from './tabTypes';

/** Response headers, who may reach the site, and how fast one visitor may ask. */

const FRAME_OPTIONS: ReadonlyArray<{ value: SiteFrameOptions; label: string }> = [
  { value: 'sameOrigin', label: 'Only this site may frame it' },
  { value: 'deny', label: 'No site may frame it' },
  { value: 'off', label: 'Do not send' },
];

const REFERRER_POLICIES: ReadonlyArray<{ value: SiteReferrerPolicy; label: string }> = [
  { value: 'strictOriginWhenCrossOrigin', label: 'strict-origin-when-cross-origin' },
  { value: 'strictOrigin', label: 'strict-origin' },
  { value: 'sameOrigin', label: 'same-origin' },
  { value: 'origin', label: 'origin' },
  { value: 'originWhenCrossOrigin', label: 'origin-when-cross-origin' },
  { value: 'noReferrer', label: 'no-referrer' },
  { value: 'noReferrerWhenDowngrade', label: 'no-referrer-when-downgrade' },
  { value: 'off', label: 'Do not send' },
];

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled: boolean;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Combobox
        id={id}
        searchable={false}
        options={options}
        value={value}
        onChange={(next) => onChange(next as T)}
        disabled={disabled}
      />
    </div>
  );
}

export function SecurityTab(props: SiteTabProps): React.JSX.Element {
  const { draft, set, error, readOnly } = props;
  const setHeader = (index: number, patch: { name?: string; value?: string }) =>
    set({ headers: draft.headers.map((row, at) => (at === index ? { ...row, ...patch } : row)) });

  return (
    <div className="space-y-2">
      <Section title="Security headers" description="Sent with every response.">
        <ToggleRow
          label="Add security headers"
          checked={draft.securityHeaders}
          onChange={(securityHeaders) => set({ securityHeaders })}
          disabled={readOnly}
        />
        {draft.securityHeaders && (
          <div className="space-y-3">
            <ToggleRow
              label="X-Content-Type-Options: nosniff"
              description="Stops browsers from guessing a file's type."
              checked={draft.noSniff}
              onChange={(noSniff) => set({ noSniff })}
              disabled={readOnly}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label="X-Frame-Options"
                value={draft.frameOptions}
                options={FRAME_OPTIONS}
                onChange={(frameOptions) => set({ frameOptions })}
                disabled={readOnly}
              />
              <Select
                label="Referrer-Policy"
                value={draft.referrerPolicy}
                options={REFERRER_POLICIES}
                onChange={(referrerPolicy) => set({ referrerPolicy })}
                disabled={readOnly}
              />
            </div>
          </div>
        )}
        <div className="space-y-2">
          <p className="text-sm text-foreground">Custom headers</p>
          <ul aria-label="Custom headers" className="space-y-2">
            {draft.headers.map((row, index) => (
              <li key={index} className="space-y-1">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Header ${index + 1} name`}
                    value={row.name}
                    onChange={(event) => setHeader(index, { name: event.target.value })}
                    placeholder="X-Robots-Tag"
                    disabled={readOnly}
                    className="font-mono"
                  />
                  <Input
                    aria-label={`Header ${index + 1} value`}
                    value={row.value}
                    onChange={(event) => setHeader(index, { value: event.target.value })}
                    placeholder="noindex"
                    disabled={readOnly}
                    className="font-mono"
                  />
                  {!readOnly && (
                    <SimpleTooltip label="Remove">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Remove header ${row.name || index + 1}`}
                        onClick={() =>
                          set({ headers: draft.headers.filter((_, at) => at !== index) })
                        }
                      >
                        <Trash2 />
                      </Button>
                    </SimpleTooltip>
                  )}
                </div>
                <FieldError message={error(`responseHeaders[${index}].name`)} />
              </li>
            ))}
          </ul>
          {!readOnly && (
            <Button
              type="button"
              variant="soft"
              size="sm"
              onClick={() => set({ headers: [...draft.headers, { name: '', value: '' }] })}
            >
              <Plus className="h-3.5 w-3.5" /> Add a header
            </Button>
          )}
          <FieldError message={error('responseHeaders')} />
        </div>
      </Section>
      <AccessFields {...props} />
      <Section
        title="Rate limit"
        description="Requests one visitor's address may make before nginx answers 429."
      >
        <ToggleRow
          label="Limit requests"
          checked={draft.rateLimit}
          onChange={(rateLimit) => set({ rateLimit })}
          disabled={readOnly}
        />
        {draft.rateLimit && (
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              label="Requests"
              value={draft.rateRequests}
              onChange={(rateRequests) => set({ rateRequests })}
              inputMode="numeric"
              disabled={readOnly}
            />
            <Select<SiteRatePeriod>
              label="Per"
              value={draft.ratePer}
              options={[
                { value: 'second', label: 'second' },
                { value: 'minute', label: 'minute' },
              ]}
              onChange={(ratePer) => set({ ratePer })}
              disabled={readOnly}
            />
            <TextField
              label="Burst"
              value={draft.rateBurst}
              onChange={(rateBurst) => set({ rateBurst })}
              hint="Extra requests let through at once."
              inputMode="numeric"
              disabled={readOnly}
            />
            <div className="sm:col-span-3">
              <ToggleRow
                label="Serve a burst at once"
                description="Off makes nginx spread the extra requests out instead."
                checked={draft.rateNoDelay}
                onChange={(rateNoDelay) => set({ rateNoDelay })}
                disabled={readOnly}
              />
            </div>
          </div>
        )}
        <FieldError message={error('rateLimit')} />
      </Section>
    </div>
  );
}
