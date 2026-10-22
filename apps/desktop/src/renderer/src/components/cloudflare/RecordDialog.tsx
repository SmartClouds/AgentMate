import {
  CLOUDFLARE_RECORD_TYPES,
  PROXIABLE_TYPES,
  recordName,
  recordProblem,
  TTL_CHOICES,
} from '@shared/cloudflare/dns';
import type {
  CloudflareCaaData,
  CloudflareDnsRecord,
  CloudflareRecordInput,
  CloudflareRecordType,
  CloudflareZone,
} from '@shared/cloudflareTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { relativeName, ttlLabel } from '@/lib/cloudflare/labels';
import { queryKeys } from '@/lib/queryKeys';
import { Field } from './fields';

interface Draft {
  type: CloudflareRecordType;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  priority: string;
  caaFlags: string;
  caaTag: CloudflareCaaData['tag'];
  caaValue: string;
  srvPriority: string;
  srvWeight: string;
  srvPort: string;
  srvTarget: string;
  comment: string;
}

const TTL_OPTIONS = TTL_CHOICES.map((ttl) => ({ value: String(ttl), label: ttlLabel(ttl) }));

const CONTENT_LABEL: Partial<Record<CloudflareRecordType, string>> = {
  A: 'IPv4 address',
  AAAA: 'IPv6 address',
  CNAME: 'Target',
  TXT: 'Content',
  MX: 'Mail server',
};

const CONTENT_PLACEHOLDER: Partial<Record<CloudflareRecordType, string>> = {
  A: '203.0.113.10',
  AAAA: '2001:db8::10',
  CNAME: 'app.example.net',
  TXT: 'v=spf1 include:_spf.example.net -all',
  MX: 'mail.example.com',
};

function emptyDraft(): Draft {
  return {
    type: 'A',
    name: '@',
    content: '',
    proxied: true,
    ttl: 1,
    priority: '10',
    caaFlags: '0',
    caaTag: 'issue',
    caaValue: '',
    srvPriority: '10',
    srvWeight: '5',
    srvPort: '',
    srvTarget: '',
    comment: '',
  };
}

function draftOf(record: CloudflareDnsRecord, zoneName: string): Draft {
  const draft = emptyDraft();
  return {
    ...draft,
    type: record.type as CloudflareRecordType,
    name: relativeName(record.name, zoneName),
    content: record.content,
    proxied: record.proxied,
    ttl: record.ttl,
    priority: String(record.priority ?? draft.priority),
    caaFlags: String(record.caa?.flags ?? 0),
    caaTag: record.caa?.tag ?? 'issue',
    caaValue: record.caa?.value ?? '',
    srvPriority: String(record.srv?.priority ?? draft.srvPriority),
    srvWeight: String(record.srv?.weight ?? draft.srvWeight),
    srvPort: String(record.srv?.port ?? ''),
    srvTarget: record.srv?.target ?? '',
    comment: record.comment ?? '',
  };
}

/** The record the form describes, or what is wrong with it. */
function buildInput(
  draft: Draft,
  zoneName: string,
  hadComment: boolean,
): { input: CloudflareRecordInput } | { problem: string } {
  const name = recordName(draft.name, zoneName);
  if (!name) {
    return {
      problem: 'That name cannot be used in DNS. Use letters, digits and hyphens, like app or www.',
    };
  }
  const comment = draft.comment.trim();
  const extra = comment || hadComment ? { comment } : {};
  const proxied = PROXIABLE_TYPES.has(draft.type) && draft.proxied;
  const ttl = proxied ? 1 : draft.ttl;
  let input: CloudflareRecordInput;
  switch (draft.type) {
    case 'A':
    case 'AAAA':
    case 'CNAME':
      input = { type: draft.type, name, content: draft.content.trim(), ttl, proxied, ...extra };
      break;
    case 'TXT':
      input = { type: 'TXT', name, content: draft.content, ttl, ...extra };
      break;
    case 'MX':
      input = {
        type: 'MX',
        name,
        content: draft.content.trim(),
        priority: Number(draft.priority),
        ttl,
        ...extra,
      };
      break;
    case 'CAA':
      input = {
        type: 'CAA',
        name,
        caa: { flags: Number(draft.caaFlags), tag: draft.caaTag, value: draft.caaValue.trim() },
        ttl,
        ...extra,
      };
      break;
    default:
      input = {
        type: 'SRV',
        name,
        srv: {
          priority: Number(draft.srvPriority),
          weight: Number(draft.srvWeight),
          port: draft.srvPort === '' ? Number.NaN : Number(draft.srvPort),
          target: draft.srvTarget.trim(),
        },
        ttl,
        ...extra,
      };
  }
  const problem = recordProblem(input);
  return problem ? { problem } : { input };
}

/**
 * Adding or editing one DNS record. The fields follow the type; names are typed inside the zone
 * ("@", "www") and the full name is shown as it will be saved. Proxied records always use the
 * automatic TTL, as Cloudflare requires.
 */
export function RecordDialog({
  zone,
  record,
  open,
  onOpenChange,
}: {
  zone: CloudflareZone;
  /** The record to edit; left out, the dialog adds one. */
  record?: CloudflareDnsRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() =>
    record ? draftOf(record, zone.name) : emptyDraft(),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(record ? draftOf(record, zone.name) : emptyDraft());
    setProblem(null);
  }, [open, record, zone.name]);

  const update = (change: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...change }));
    setProblem(null);
  };
  const proxiable = PROXIABLE_TYPES.has(draft.type);
  const proxied = proxiable && draft.proxied;
  const fullName = recordName(draft.name, zone.name);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const built = buildInput(draft, zone.name, Boolean(record?.comment));
    if ('problem' in built) {
      setProblem(built.problem);
      return;
    }
    setBusy(true);
    try {
      if (record) {
        await window.agentmat.cloudflare.updateRecord(zone.id, record.id, built.input);
      } else {
        await window.agentmat.cloudflare.createRecord(zone.id, built.input);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.cloudflareRecords(zone.id) });
      toast.success(`Saved the ${built.input.type} record for ${built.input.name}.`);
      onOpenChange(false);
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy(false);
    }
  }

  const field = (name: string) => `${id}-${name}`;
  const numberField = (key: keyof Draft, label: string, placeholder?: string) => (
    <Field label={label} htmlFor={field(key)}>
      <Input
        id={field(key)}
        type="number"
        min={0}
        value={draft[key] as string}
        placeholder={placeholder}
        onChange={(event) => update({ [key]: event.target.value } as Partial<Draft>)}
      />
    </Field>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form
          onSubmit={(event) => void save(event)}
          className="flex max-h-[calc(85vh-3rem)] min-h-0 flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>
              {record ? `Edit the ${record.type} record` : 'Add a DNS record'}
            </DialogTitle>
            <DialogDescription>
              Changes reach Cloudflare as soon as you save. Most resolvers see them within minutes.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1">
            <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <Field label="Type" htmlFor={field('type')}>
                <Combobox
                  id={field('type')}
                  searchable={false}
                  options={CLOUDFLARE_RECORD_TYPES.map((type) => ({ value: type, label: type }))}
                  value={draft.type}
                  disabled={Boolean(record)}
                  onChange={(type) => update({ type: type as CloudflareRecordType, content: '' })}
                />
              </Field>
              <Field
                label="Name"
                htmlFor={field('name')}
                hint={
                  <>
                    Saved as{' '}
                    <span className="font-mono">{fullName ?? 'a name DNS cannot hold'}</span>. Use @
                    for {zone.name} itself.
                  </>
                }
              >
                <Input
                  id={field('name')}
                  value={draft.name}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </Field>
            </div>

            {draft.type === 'TXT' && (
              <Field label="Content" htmlFor={field('content')}>
                <Textarea
                  id={field('content')}
                  value={draft.content}
                  rows={3}
                  spellCheck={false}
                  placeholder={CONTENT_PLACEHOLDER.TXT}
                  className="font-mono text-xs"
                  onChange={(event) => update({ content: event.target.value })}
                />
              </Field>
            )}
            {(proxiable || draft.type === 'MX') && (
              <Field label={CONTENT_LABEL[draft.type] ?? 'Content'} htmlFor={field('content')}>
                <Input
                  id={field('content')}
                  value={draft.content}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={CONTENT_PLACEHOLDER[draft.type]}
                  className="font-mono"
                  onChange={(event) => update({ content: event.target.value })}
                />
              </Field>
            )}
            {draft.type === 'MX' && numberField('priority', 'Priority')}
            {draft.type === 'CAA' && (
              <div className="grid gap-3 sm:grid-cols-[6rem_9rem_minmax(0,1fr)]">
                {numberField('caaFlags', 'Flags')}
                <Field label="Tag" htmlFor={field('caaTag')}>
                  <Combobox
                    id={field('caaTag')}
                    searchable={false}
                    options={[
                      { value: 'issue', label: 'issue' },
                      { value: 'issuewild', label: 'issuewild' },
                      { value: 'iodef', label: 'iodef' },
                    ]}
                    value={draft.caaTag}
                    onChange={(tag) => update({ caaTag: tag as CloudflareCaaData['tag'] })}
                  />
                </Field>
                <Field label="Value" htmlFor={field('caaValue')}>
                  <Input
                    id={field('caaValue')}
                    value={draft.caaValue}
                    placeholder="letsencrypt.org"
                    className="font-mono"
                    onChange={(event) => update({ caaValue: event.target.value })}
                  />
                </Field>
              </div>
            )}
            {draft.type === 'SRV' && (
              <div className="grid gap-3 sm:grid-cols-3">
                {numberField('srvPriority', 'Priority')}
                {numberField('srvWeight', 'Weight')}
                {numberField('srvPort', 'Port', '5060')}
                <Field label="Target" htmlFor={field('srvTarget')} className="sm:col-span-3">
                  <Input
                    id={field('srvTarget')}
                    value={draft.srvTarget}
                    placeholder="sip.example.com"
                    className="font-mono"
                    onChange={(event) => update({ srvTarget: event.target.value })}
                  />
                </Field>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {proxiable && (
                <div className="flex items-center justify-between gap-3 rounded-xl bg-foreground/[0.03] px-3 py-2 ring-1 ring-inset ring-foreground/[0.08]">
                  <div className="min-w-0">
                    <p id={field('proxyLabel')} className="text-sm font-medium">
                      Proxy through Cloudflare
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {proxied
                        ? 'Proxied: visitors reach Cloudflare first.'
                        : 'DNS only: visitors reach the server directly.'}
                    </p>
                  </div>
                  <Switch
                    checked={proxied}
                    aria-labelledby={field('proxyLabel')}
                    onCheckedChange={(checked) => update({ proxied: checked })}
                  />
                </div>
              )}
              <Field
                label="TTL"
                htmlFor={field('ttl')}
                hint={proxied ? 'Proxied records always use Auto.' : undefined}
              >
                <Combobox
                  id={field('ttl')}
                  searchable={false}
                  options={TTL_OPTIONS}
                  value={String(proxied ? 1 : draft.ttl)}
                  disabled={proxied}
                  onChange={(ttl) => update({ ttl: Number(ttl) })}
                />
              </Field>
            </div>

            <Field
              label="Comment"
              htmlFor={field('comment')}
              hint="Only you see it; DNS ignores it."
            >
              <Input
                id={field('comment')}
                value={draft.comment}
                maxLength={500}
                onChange={(event) => update({ comment: event.target.value })}
              />
            </Field>

            {problem && (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="soft" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Save record
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
