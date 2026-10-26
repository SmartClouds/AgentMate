import { validateIpOrCidr, validatePort } from '@runova/core';
import { coreErrorMessage } from '@shared/coreErrors';
import type {
  StreamProxyInfo,
  StreamProxyProtocol,
  StreamProxySettings,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useEffect, useId, useState } from 'react';
import { Save, Spinner } from '@/components/icons';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { problemsFor } from '@/lib/deploy/sites/problems';
import { splitList } from '@/lib/deploy/sites/settings';
import { FieldError, TextField } from './fields';

/**
 * A public TCP or UDP port that nginx passes on to an address behind it, such as a database
 * kept off the internet except for a few addresses.
 */

const ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

interface Draft {
  id: string;
  protocol: StreamProxyProtocol;
  listenPort: string;
  target: string;
  allowFrom: string;
}

function toDraft(proxy: StreamProxyInfo | null): Draft {
  if (!proxy) return { id: '', protocol: 'tcp', listenPort: '', target: '', allowFrom: '' };
  const s = proxy.settings;
  return {
    id: s.id,
    protocol: s.protocol,
    listenPort: String(s.listenPort),
    target: s.upstream.address ?? (s.upstream.port ? `127.0.0.1:${s.upstream.port}` : ''),
    allowFrom: (s.allowFrom ?? []).join('\n'),
  };
}

export function toStreamSettings(draft: Draft): {
  settings: StreamProxySettings;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  if (!ID.test(draft.id)) errors.id = 'Use lowercase letters, digits and hyphens.';
  const port = validatePort(draft.listenPort.trim());
  if (!port.ok) errors.listenPort = port.reason;
  if (!/^[^\s:]+:\d{1,5}$|^\[[0-9a-f:]+\]:\d{1,5}$/i.test(draft.target.trim())) {
    errors.upstream = 'Enter an address and port, such as 127.0.0.1:5432.';
  }
  const allowFrom = splitList(draft.allowFrom);
  allowFrom.forEach((entry, index) => {
    const checked = validateIpOrCidr(entry);
    if (!checked.ok) errors[`allowFrom[${index}]`] = `${entry}: ${checked.reason}`;
  });
  return {
    settings: {
      id: draft.id,
      protocol: draft.protocol,
      listenPort: port.ok ? port.value : 0,
      upstream: {
        kind: 'endpoint',
        address: draft.target.trim(),
        verifyCertificate: false,
        sendUpstreamHost: false,
      },
      ...(allowFrom.length > 0 ? { allowFrom } : {}),
    },
    errors,
  };
}

export function StreamProxyDialog({
  serverId,
  proxy,
  open,
  onClose,
  onSaved,
}: {
  serverId: string;
  /** Null for a new proxy. */
  proxy: StreamProxyInfo | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const protocolId = useId();
  const allowId = useId();
  const [draft, setDraft] = useState<Draft>(() => toDraft(proxy));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  useEffect(() => {
    if (!open) return;
    setDraft(toDraft(proxy));
    setErrors({});
    setFailure(null);
  }, [open, proxy]);

  async function save(): Promise<void> {
    const { settings, errors: local } = toStreamSettings(draft);
    setErrors(local);
    setFailure(null);
    if (Object.keys(local).length > 0) return;
    setBusy(true);
    try {
      const result = await window.runova.deploySites.saveStream(serverId, settings);
      if (result.problems.length > 0) {
        setErrors(
          Object.fromEntries(
            problemsFor(result.problems, 'stream', settings.id).map((p) => [p.path, p.message]),
          ),
        );
        const general = result.problems.find((p) => !p.field.startsWith(`streams[${settings.id}]`));
        if (general) setFailure(general.message);
        return;
      }
      onSaved();
    } catch (error) {
      setFailure(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const allowErrors = Object.entries(errors).filter(([path]) => path.startsWith('allowFrom'));
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {proxy ? `Edit ${proxy.settings.id}` : 'Add a TCP or UDP proxy'}
          </DialogTitle>
          <DialogDescription>
            nginx listens on a public port and passes each connection on. The firewall still has to
            let the port in.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Id"
            value={draft.id}
            onChange={(id) => set({ id: id.toLowerCase() })}
            error={errors.id}
            disabled={proxy !== null}
            placeholder="postgres"
            mono
          />
          <div className="space-y-1.5">
            <Label htmlFor={protocolId}>Protocol</Label>
            <Combobox
              id={protocolId}
              searchable={false}
              options={[
                { value: 'tcp', label: 'TCP' },
                { value: 'udp', label: 'UDP' },
              ]}
              value={draft.protocol}
              onChange={(protocol) => set({ protocol: protocol as StreamProxyProtocol })}
            />
          </div>
          <TextField
            label="Public port"
            value={draft.listenPort}
            onChange={(listenPort) => set({ listenPort })}
            error={errors.listenPort}
            inputMode="numeric"
            placeholder="5432"
            mono
          />
          <TextField
            label="Passes to"
            value={draft.target}
            onChange={(target) => set({ target })}
            error={errors.upstream}
            placeholder="127.0.0.1:5432"
            mono
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={allowId}>Allow only these addresses</Label>
          <Textarea
            id={allowId}
            value={draft.allowFrom}
            onChange={(event) => set({ allowFrom: event.target.value })}
            rows={3}
            placeholder={'203.0.113.4\n10.0.0.0/8'}
            spellCheck={false}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            One per line. Leave empty to let anyone connect.
          </p>
          {allowErrors.map(([path, message]) => (
            <FieldError key={path} message={message} />
          ))}
        </div>
        <FieldError message={failure ?? undefined} />
        <DialogFooter>
          <Button type="button" variant="soft" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={() => void save()}>
            {busy ? (
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save the proxy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
