import { checkPurgeUrls, PURGE_URL_LIMIT } from '@shared/cloudflare/zone';
import type { CloudflareZone } from '@shared/cloudflareTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Bolt, Spinner, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { CardBody, CloudflareCard } from './fields';

/** A full purge, behind typing the domain's name (the ResetVaultDialog pattern). */
function PurgeEverythingDialog({
  zone,
  open,
  onOpenChange,
}: {
  zone: CloudflareZone;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function purge(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await window.runova.cloudflare.purgeCache(zone.id, { everything: true });
      toast.success(`Purged everything for ${zone.name}.`);
      setTyped('');
      onOpenChange(false);
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTyped('');
          setProblem(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Purge everything for {zone.name}?</DialogTitle>
          <DialogDescription>
            Every cached file goes at once, so the next visits all reach your server until the cache
            fills again. That can slow the site down or strain the server for a while.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={inputId} className="text-sm font-normal">
            Type <span className="font-mono font-semibold">{zone.name}</span> to confirm
          </Label>
          <Input
            id={inputId}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={typed.trim() !== zone.name || busy}
            onClick={() => void purge()}
          >
            {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Purge everything
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Cache purges (T3): the listed URLs straight away, or everything after typing the domain's
 * name, since a full purge sends every next request to the server.
 */
export function PurgeCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [urls, setUrls] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function purgeUrls(): Promise<void> {
    const checked = checkPurgeUrls(urls);
    if (!checked.ok) {
      setProblem(checked.problem);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await window.runova.cloudflare.purgeCache(zone.id, { urls: checked.urls });
      const count = checked.urls.length;
      toast.success(`Purged ${count} ${count === 1 ? 'URL' : 'URLs'} from the cache.`);
      setUrls('');
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CloudflareCard
      icon={<Bolt />}
      title="Cache"
      description="Cloudflare keeps copies of your files close to visitors. Purge them when a change does not show up."
    >
      <CardBody className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={fieldId}>URLs to purge</Label>
          <Textarea
            id={fieldId}
            value={urls}
            rows={3}
            spellCheck={false}
            placeholder={`https://${zone.name}/styles.css`}
            className="font-mono text-xs"
            onChange={(event) => {
              setUrls(event.target.value);
              setProblem(null);
            }}
          />
          <p className="text-xs text-muted-foreground">
            One full URL per line, up to {PURGE_URL_LIMIT} at a time.
          </p>
        </div>
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" disabled={busy || urls.trim() === ''} onClick={() => void purgeUrls()}>
            {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Purge these URLs
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
            <Trash2 className="h-3.5 w-3.5" /> Purge everything
          </Button>
        </div>
      </CardBody>
      <PurgeEverythingDialog zone={zone} open={confirming} onOpenChange={setConfirming} />
    </CloudflareCard>
  );
}
