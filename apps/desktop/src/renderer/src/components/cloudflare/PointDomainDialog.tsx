import { sslAdvice } from '@shared/cloudflare/zone';
import type {
  CloudflarePlannedChange,
  CloudflarePointDomainInput,
  CloudflarePointDomainPlan,
  CloudflareZone,
  CloudflareZoneSettings,
} from '@shared/cloudflareTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  CircleCheck,
  CircleInfo,
  Globe,
  Minus,
  Pencil,
  Plus,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
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
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { Field } from './fields';

const ACTION_TEXT: Record<CloudflarePlannedChange['action'], string> = {
  create: 'Add',
  update: 'Change',
  delete: 'Remove',
  keep: 'Keep',
};

const ACTION_ICON = { create: Plus, update: Pencil, delete: Minus, keep: CircleCheck } as const;

function detail(change: CloudflarePlannedChange): string {
  if (change.action === 'delete') {
    return `${change.content}: ${
      change.reason === 'cname-conflict'
        ? 'a CNAME cannot share a name with address records'
        : 'it points somewhere else'
    }`;
  }
  if (change.action === 'update' && change.previous !== change.content) {
    return `${change.previous} to ${change.content}`;
  }
  if (change.action === 'update') {
    return `${change.content}, ${change.proxied ? 'now proxied' : 'now DNS only'}`;
  }
  return change.content;
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-foreground/[0.03] px-3 py-2 ring-1 ring-inset ring-foreground/[0.08]">
      <div className="min-w-0">
        <p id={id} className="text-sm font-medium">
          {label}
        </p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} aria-labelledby={id} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * Points a name in the zone (and its www) at one of the saved servers. The preview lists every
 * record that would be added, changed or removed, so nothing happens that was not shown; applying
 * runs as one batch on Cloudflare, and running it again finds nothing to change.
 */
export function PointDomainDialog({
  zone,
  open,
  onOpenChange,
}: {
  zone: CloudflareZone;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const id = useId();
  const serversQuery = useQuery({
    queryKey: queryKeys.deployServers,
    queryFn: () => window.agentmat.deploy.listServers(),
  });
  const servers = (serversQuery.data ?? []).filter((server) => !server.dev);
  const [serverId, setServerId] = useState('');
  const [name, setName] = useState('@');
  const [includeWww, setIncludeWww] = useState(true);
  const [proxied, setProxied] = useState(true);
  const [plan, setPlan] = useState<CloudflarePointDomainPlan | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [done, setDone] = useState<{ names: string[]; serverId: string; nickname: string } | null>(
    null,
  );
  const navigate = useNavigate();

  const server = servers.find((candidate) => candidate.id === serverId) ?? servers[0];
  const input: CloudflarePointDomainInput | null = server
    ? { zoneId: zone.id, name: name.trim() || '@', serverId: server.id, includeWww, proxied }
    : null;
  const changing = plan?.changes.filter((change) => change.action !== 'keep') ?? [];
  const settings = queryClient.getQueryData<CloudflareZoneSettings>(
    queryKeys.cloudflareSettings(zone.id),
  );
  const advice = proxied && settings ? sslAdvice(settings.ssl.value) : null;

  const reset =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPlan(null);
      setProblem(null);
    };

  async function preview(): Promise<void> {
    if (!input) return;
    setBusy('preview');
    setProblem(null);
    try {
      setPlan(await window.agentmat.cloudflare.planPointDomain(input));
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy(null);
    }
  }

  async function apply(): Promise<void> {
    if (!input || !plan || !server) return;
    setBusy('apply');
    setProblem(null);
    try {
      const result = await window.agentmat.cloudflare.pointDomain(input);
      toast.success(`${result.plan.names[0]} now points to ${server.nickname}.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.cloudflareRecords(zone.id) });
      setDone({ names: result.plan.names, serverId: server.id, nickname: server.nickname });
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy(null);
    }
  }

  function close(next: boolean): void {
    if (!next) {
      setDone(null);
      setPlan(null);
    }
    onOpenChange(next);
  }

  /** The next step after the records: a site on the server for the same names (E14 T5). */
  function addWebsite(): void {
    if (!done) return;
    const params = new URLSearchParams({
      server: done.serverId,
      view: 'websites',
      newSite: done.names.join(','),
    });
    close(false);
    navigate(`/deploy?${params.toString()}`);
  }

  if (done) {
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {done.names[0]} points to {done.nickname}
            </DialogTitle>
            <DialogDescription>
              The records are in place. To answer for {done.names.join(' and ')}, the server needs a
              website for them in nginx.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="soft" onClick={() => close(false)}>
              Close
            </Button>
            <Button type="button" onClick={addWebsite}>
              <Globe className="h-3.5 w-3.5" /> Add a website on {done.nickname}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl">
        <div className="flex max-h-[calc(85vh-3rem)] min-h-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Point a domain to a server</DialogTitle>
            <DialogDescription>
              Creates or updates the address records so the name reaches one of your saved servers,
              and nothing else. You see every change before it is made.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1">
            {serversQuery.isSuccess && servers.length === 0 ? (
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <CircleInfo className="mt-0.5 h-4 w-4 shrink-0" /> Save a server in Remote first,
                then point a domain to it.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Server" htmlFor={`${id}-server`}>
                  <Combobox
                    id={`${id}-server`}
                    options={servers.map((candidate) => ({
                      value: candidate.id,
                      label: candidate.nickname,
                    }))}
                    value={server?.id ?? ''}
                    onChange={(serverId) => reset(setServerId)(serverId)}
                    placeholder="Pick a server"
                    searchPlaceholder="Search servers…"
                    emptyText="No server matches."
                  />
                </Field>
                <Field
                  label="Name"
                  htmlFor={`${id}-name`}
                  hint={`Use @ for ${zone.name} itself, or a name inside it, like app.`}
                >
                  <Input
                    id={`${id}-name`}
                    value={name}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => reset(setName)(event.target.value)}
                  />
                </Field>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <SwitchRow
                id={`${id}-www`}
                label="Also point www"
                description="The same addresses for the www name."
                checked={includeWww}
                onChange={reset(setIncludeWww)}
              />
              <SwitchRow
                id={`${id}-proxy`}
                label="Proxy through Cloudflare"
                description={
                  proxied
                    ? 'Visitors reach Cloudflare first.'
                    : 'Visitors reach the server directly.'
                }
                checked={proxied}
                onChange={reset(setProxied)}
              />
            </div>

            {plan && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Addresses for {server?.nickname}:{' '}
                  <span className="font-mono">
                    {[...plan.addresses.ipv4, ...plan.addresses.ipv6].join(', ')}
                  </span>
                </p>
                {plan.upToDate ? (
                  <p className="flex items-start gap-2 rounded-xl bg-success/[0.08] p-3 text-sm text-foreground ring-1 ring-inset ring-success/25">
                    <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    {plan.names.join(' and ')} already point at {server?.nickname}. Nothing to
                    change.
                  </p>
                ) : (
                  <ul
                    aria-label="Changes"
                    className="settings-rows rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.08]"
                  >
                    {plan.changes.map((change) => {
                      const Icon = ACTION_ICON[change.action];
                      return (
                        <li
                          key={`${change.action}-${change.type}-${change.name}-${change.content}`}
                          className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-sm"
                        >
                          <span
                            className={cn(
                              'flex w-20 shrink-0 items-center gap-1.5 text-xs font-medium',
                              change.action === 'delete' ? 'text-destructive' : 'text-foreground',
                            )}
                          >
                            <Icon className="h-3 w-3" />
                            {ACTION_TEXT[change.action]}
                          </span>
                          <span className="font-mono text-xs text-foreground">
                            {change.type} {change.name}
                          </span>
                          <span className="min-w-0 flex-1 break-words text-xs text-muted-foreground">
                            {detail(change)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {advice && advice.level !== 'ok' && (
                  <p className="flex items-start gap-2 rounded-xl bg-warning/[0.08] p-3 text-sm text-foreground ring-1 ring-inset ring-warning/30">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <span>
                      SSL/TLS for proxied records: {advice.message} You can change it under
                      Settings.
                    </span>
                  </p>
                )}
              </div>
            )}
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
            {plan && !plan.upToDate ? (
              <Button disabled={busy !== null} onClick={() => void apply()}>
                {busy === 'apply' && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
                {`Apply ${changing.length} ${changing.length === 1 ? 'change' : 'changes'}`}
              </Button>
            ) : (
              <Button disabled={!input || busy !== null} onClick={() => void preview()}>
                {busy === 'preview' && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
                Preview changes
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
