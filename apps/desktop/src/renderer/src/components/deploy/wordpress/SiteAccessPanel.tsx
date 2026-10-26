import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Key, LinkOff, Lock, Pencil, Spinner } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { Switch } from '@/components/ui/switch';
import { queryKeys } from '@/lib/queryKeys';
import { DeployCard, FactRow, FactRows, GLASS_EDGE } from '../deployKit';
import { AuditLogList } from './AuditLogList';
import { siteProjects, useProjects, useSiteInfo, useSiteSettings } from './hooks';
import {
  dateTimeText,
  lastSeenText,
  SCOPE_LABEL,
  SCOPE_SUMMARY,
  siteTimeText,
  TRANSPORT_LABEL,
  wpProblem,
} from './messages';
import { PlainHttpNotice } from './PlainHttpNotice';

function ConnectionCard({ site }: { site: DeployWordPressSite }): React.JSX.Element {
  const info = useSiteInfo(site.id).data;
  return (
    <DeployCard
      icon={<Key />}
      title="Connection"
      extra={
        <Chip tone={site.scope === 'read' ? 'neutral' : 'primary'}>{SCOPE_LABEL[site.scope]}</Chip>
      }
      description={
        <span className="block max-w-2xl">
          {SCOPE_SUMMARY[site.scope]}
          {site.scope === 'read' &&
            ' To deploy, make a read and write key in Tools > Runova Connector and connect the site again.'}
        </span>
      }
    >
      <FactRows>
        <FactRow label="Site address">
          <span className="font-mono text-xs">{site.siteUrl}</span>
        </FactRow>
        {site.siteName && site.siteName !== site.label && (
          <FactRow label="Site name">{site.siteName}</FactRow>
        )}
        <FactRow label="Travels over">{TRANSPORT_LABEL[site.transport]}</FactRow>
        <FactRow label="Connected">{dateTimeText(site.connectedAt)}</FactRow>
        <FactRow label="Last reached">{lastSeenText(site)}</FactRow>
        <FactRow label="Connector">
          {site.pluginVersion}
          <span className="text-muted-foreground">, protocol {site.protocol}</span>
        </FactRow>
        {info && (
          <>
            <FactRow label="Name on the site">{info.connection.label || 'Not named'}</FactRow>
            <FactRow label="Key expires">
              {info.connection.expiresAt === null
                ? 'Never'
                : siteTimeText(info.connection.expiresAt)}
            </FactRow>
          </>
        )}
      </FactRows>
      <p className="mt-3 text-xs text-muted-foreground">
        This computer holds its own private key for the site, sealed with your other Servers
        secrets. Every request and every reply is signed, and the key you pasted to connect worked
        only once.
      </p>
    </DeployCard>
  );
}

function RenameCard({ site }: { site: DeployWordPressSite }): React.JSX.Element {
  const id = useId();
  const save = useSiteSettings(site.id);
  const [draft, setDraft] = useState(site.label);
  const [busy, setBusy] = useState(false);
  const trimmed = draft.trim();

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!trimmed || trimmed === site.label) return;
    setBusy(true);
    try {
      await save({ label: trimmed });
      toast.success('Renamed the site.');
    } catch (error) {
      toast.error(wpProblem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DeployCard
      icon={<Pencil />}
      title="Name"
      description="What Runova calls this site. The site itself isn't changed."
    >
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void submit(event)}>
        <div className="min-w-[14rem] flex-1 space-y-1.5">
          <Label htmlFor={`${id}-label`}>Name in Runova</Label>
          <Input
            id={`${id}-label`}
            value={draft}
            maxLength={100}
            onChange={(event) => setDraft(event.target.value)}
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={busy || !trimmed || trimmed === site.label}>
          {busy && <Spinner className="motion-safe:animate-spin" />}
          Save
        </Button>
      </form>
    </DeployCard>
  );
}

function PlainHttpCard({ site }: { site: DeployWordPressSite }): React.JSX.Element | null {
  const id = useId();
  const save = useSiteSettings(site.id);
  const [busy, setBusy] = useState(false);
  if (site.transport !== 'plain-http') return null;

  async function toggle(allowPlainHttp: boolean): Promise<void> {
    setBusy(true);
    try {
      await save({ allowPlainHttp });
      toast.success(
        allowPlainHttp
          ? 'Plain HTTP is allowed for this site.'
          : "Plain HTTP is off. Runova won't reach this site until it has HTTPS or you allow it again.",
      );
    } catch (error) {
      toast.error(wpProblem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PlainHttpNotice>
      <div className="flex items-center gap-3">
        <Switch
          id={`${id}-plain`}
          checked={site.allowPlainHttp}
          disabled={busy}
          onCheckedChange={(checked) => void toggle(checked)}
        />
        <Label htmlFor={`${id}-plain`} className="cursor-pointer">
          Allow plain HTTP for this site
        </Label>
      </div>
      {!site.allowPlainHttp && (
        <p className="text-xs text-muted-foreground">
          Off, so Runova won't talk to this site until you allow it.
        </p>
      )}
    </PlainHttpNotice>
  );
}

/** HTTP Basic sign-in for a staging site. The password goes in and is never shown again. */
function HttpAuthCard({ site }: { site: DeployWordPressSite }): React.JSX.Element {
  const id = useId();
  const save = useSiteSettings(site.id);
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const showForm = editing || !site.hasHttpAuth;

  function reset(): void {
    setUsername('');
    setPassword('');
    setEditing(false);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    try {
      await save({ httpAuth: { username: username.trim(), password } });
      reset();
      toast.success('Saved the HTTP sign-in.');
    } catch (error) {
      setPassword('');
      toast.error(wpProblem(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    try {
      await save({ httpAuth: null });
      reset();
      toast.success('Removed the HTTP sign-in.');
    } catch (error) {
      toast.error(wpProblem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DeployCard
      icon={<Lock />}
      title="HTTP sign-in"
      description="For staging sites that ask for a user name and password before WordPress even loads. Most sites don't need this."
      bodyClassName="space-y-3"
    >
      {site.hasHttpAuth && !editing && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-foreground">
            A sign-in is saved. The password is sealed on this computer and is never shown again.
          </p>
          <Button size="sm" variant="soft" disabled={busy} onClick={() => setEditing(true)}>
            Change
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
            Remove
          </Button>
        </div>
      )}
      {showForm && (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-user`}>User name</Label>
            <Input
              id={`${id}-user`}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-password`}>Password</Label>
            <SecretInput id={`${id}-password`} value={password} onChange={setPassword} />
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" size="sm" disabled={busy || !username.trim() || !password}>
              {busy && <Spinner className="motion-safe:animate-spin" />}
              Save sign-in
            </Button>
            {editing && (
              <Button type="button" size="sm" variant="soft" onClick={reset}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </DeployCard>
  );
}

function DisconnectDialog({
  site,
  open,
  onOpenChange,
  onDisconnected,
}: {
  site: DeployWordPressSite;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnected: () => void;
}): React.JSX.Element {
  const id = useId();
  const queryClient = useQueryClient();
  const linked = siteProjects(useProjects().data, site.id);
  const [revokeOnSite, setRevokeOnSite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function disconnect(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await window.runova.deployWordPress.disconnect({ siteId: site.id, revokeOnSite });
      queryClient.setQueryData<DeployWordPressSite[]>(queryKeys.deployWordPressSites, (sites) =>
        sites?.filter((one) => one.id !== site.id),
      );
      queryClient.removeQueries({ queryKey: queryKeys.deployWordPressSite(site.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployWordPressSites });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      toast.success(`Disconnected ${site.label}.`);
      onOpenChange(false);
      onDisconnected();
    } catch (error) {
      setProblem(wpProblem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setProblem(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect {site.label}?</DialogTitle>
          <DialogDescription>
            Runova forgets this site and its key on this computer. Nothing on the site changes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {linked.length > 0 && (
            <p className="text-sm text-foreground">
              {linked.length === 1
                ? '1 project is linked to this site. It keeps its files'
                : `${linked.length} projects are linked to this site. They keep their files`}
              , but can't pull or deploy until you connect the site again and link{' '}
              {linked.length === 1 ? 'it' : 'them'}.
            </p>
          )}
          <div className="flex items-start gap-2.5">
            <Checkbox
              id={`${id}-revoke`}
              checked={revokeOnSite}
              onCheckedChange={(checked) => setRevokeOnSite(checked === true)}
              className="mt-0.5"
            />
            <Label htmlFor={`${id}-revoke`} className="cursor-pointer space-y-1 leading-snug">
              <span className="block">Also revoke this computer's key on the site</span>
              <span className="block text-xs font-normal text-muted-foreground">
                Recommended. The site stops accepting this computer's requests. If the site can't be
                reached, Runova still forgets it here; revoke the connection in wp-admin later.
              </span>
            </Label>
          </div>
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void disconnect()}>
            {busy && <Spinner className="motion-safe:animate-spin" />}
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Who this computer is to the site and how it gets there: the key's scope, the plain-HTTP
 * opt-in, an HTTP sign-in for staging sites, the name, disconnecting, and the site's audit log.
 */
export function SiteAccessPanel({
  site,
  onDisconnected,
}: {
  site: DeployWordPressSite;
  onDisconnected: () => void;
}): React.JSX.Element {
  const [disconnecting, setDisconnecting] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <PlainHttpCard site={site} />
      <ConnectionCard site={site} />
      <div className="grid items-start gap-2 xl:grid-cols-2">
        <RenameCard site={site} />
        <HttpAuthCard site={site} />
      </div>
      <AuditLogList site={site} />
      <DeployCard
        className={GLASS_EDGE.destructive}
        icon={<LinkOff />}
        tone="destructive"
        title="Disconnect"
        description="Forget this site on this computer."
        actions={
          <Button size="sm" variant="danger" onClick={() => setDisconnecting(true)}>
            Disconnect
          </Button>
        }
      />
      <DisconnectDialog
        site={site}
        open={disconnecting}
        onOpenChange={setDisconnecting}
        onDisconnected={onDisconnected}
      />
    </div>
  );
}
