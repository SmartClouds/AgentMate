import { validateDomain } from '@runova/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ArrowRight, CircleCheck, ExternalLink, Globe, Spinner } from '@/components/icons';
import { SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { type ExposeStep, initialExposeSteps } from '@/lib/deploy/sites/expose';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { type ExposeRun, exposeKey, useDeployExposeStore } from '@/stores/deployExposeStore';
import { ExposeStepList } from '../sites/ExposeSteps';
import { TextField, ToggleRow } from '../sites/fields';

/**
 * Puts one published port of an app on a domain: a site in Websites that forwards the domain to
 * the port on 127.0.0.1, nginx applied, then a certificate if asked for. The steps show as they
 * run, and a failed one keeps the form so the domain can be fixed and tried again. They run in
 * the expose store, so closing the dialog or leaving the page mid-way keeps them going.
 */

export interface ProxyRoute {
  /** The app's name, which starts the label the site keeps for the upstream. */
  stack: string;
  service: string;
  /** The port inside the container. */
  target: number;
  /** The port on the server that nginx forwards to. */
  port: number;
}

type Phase = 'form' | 'working' | 'done' | 'failed';

const NO_STEPS: ExposeStep[] = initialExposeSteps();

const ROUTE_STOP =
  'min-w-0 rounded-md bg-foreground/[0.04] px-1.5 py-0.5 font-mono ring-1 ring-inset ring-foreground/[0.08]';

export function ProxyRouteDialog({
  serverId,
  route,
  open,
  onClose,
  onOpenWebsites,
}: {
  serverId: string;
  route: ProxyRoute;
  open: boolean;
  onClose: () => void;
  onOpenWebsites?: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const key = exposeKey(serverId, `${route.stack}-${route.service}:${route.target}`);
  // The steps run in the store, so closing the dialog or leaving the page keeps them going.
  const kept = useDeployExposeStore((state): ExposeRun | undefined => state.runs[key]);
  const [domain, setDomain] = useState('');
  const [certificate, setCertificate] = useState(true);
  const [websocket, setWebsocket] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const phase: Phase = kept?.phase ?? 'form';
  const steps = kept?.steps ?? NO_STEPS;
  const live = kept?.domain ?? '';
  const name = `${route.service}:${route.target}`;
  const working = phase === 'working';

  // biome-ignore lint/correctness/useExhaustiveDependencies: only opening the dialog starts afresh
  useEffect(() => {
    if (!open) return;
    const run = useDeployExposeStore.getState().runs[key];
    setDomain(run?.domain ?? '');
    setCertificate(run?.certificate ?? true);
    setWebsocket(true);
    setError(undefined);
  }, [open]);

  function check(): string | null {
    const checked = validateDomain(domain.trim());
    setError(checked.ok ? undefined : checked.reason);
    return checked.ok ? checked.value : null;
  }

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (working) return;
    const value = check();
    if (!value) return;
    setDomain(value);
    void useDeployExposeStore.getState().expose(
      key,
      {
        serverId,
        domain: value,
        service: `${route.stack}-${route.service}`,
        port: route.port,
        certificate,
        websocket,
      },
      () => void queryClient.invalidateQueries({ queryKey: queryKeys.deployWeb(serverId) }),
    );
  }

  /** Closes the dialog; a run that has ended is done with, so the next time starts at the form. */
  function close(): void {
    if (!working) useDeployExposeStore.getState().clear(key);
    onClose();
  }

  const url = `${kept?.certificate ? 'https' : 'http'}://${live}`;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !working && close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Put {name} on a domain</DialogTitle>
          <DialogDescription>
            nginx answers for the domain and forwards each request to this port on the server. The
            port itself stays on 127.0.0.1.
          </DialogDescription>
        </DialogHeader>

        <p
          aria-label="Route"
          className={cn(SECTION_WELL, 'flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs')}
        >
          <Globe className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span
            className={cn(
              ROUTE_STOP,
              '[overflow-wrap:anywhere]',
              domain.trim() ? 'text-foreground' : 'font-sans text-muted-foreground',
            )}
          >
            {domain.trim() || 'your domain'}
          </span>
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className={cn(ROUTE_STOP, 'text-foreground')}>127.0.0.1:{route.port}</span>
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className={cn(ROUTE_STOP, 'text-foreground')}>{name}</span>
        </p>

        {phase === 'form' ? (
          <form className="space-y-1" onSubmit={submit}>
            <TextField
              label="Domain"
              value={domain}
              onChange={(next) => {
                setDomain(next);
                if (error) setError(undefined);
              }}
              onBlur={() => domain.trim() && check()}
              error={error}
              hint="Point its DNS (an A or AAAA record) at this server first."
              placeholder="app.example.com"
              mono
              autoFocus
            />
            <ToggleRow
              label="Get an HTTPS certificate"
              description="Asks Let's Encrypt once nginx serves the domain, which accepts its terms of service. Renewal is automatic."
              checked={certificate}
              onChange={setCertificate}
            />
            <ToggleRow
              label="WebSocket"
              description="Lets live connections through, for apps that push updates."
              checked={websocket}
              onChange={setWebsocket}
            />
            <DialogFooter className="pt-3">
              <Button type="button" variant="soft" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">
                <Globe className="h-3.5 w-3.5" /> Add the domain
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div role="status" aria-live="polite" className="space-y-3">
            <ExposeStepList label="Steps" steps={steps} className={cn(SECTION_WELL, 'p-3')} />
            {phase === 'done' && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <CircleCheck className="h-4 w-4 shrink-0 text-success" />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {live} is set up.
                  {kept?.certificate && (
                    <span className="block text-xs text-muted-foreground">
                      HTTPS works once the certificate arrives, usually within a minute.
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="soft"
                  onClick={() => void window.runova.shell.openExternal(url)}
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open {url}
                </Button>
              </div>
            )}
          </div>
        )}

        {phase !== 'form' && (
          <DialogFooter>
            {working && (
              <Button type="button" disabled>
                <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" /> Working
              </Button>
            )}
            {phase === 'failed' && (
              <>
                <Button type="button" variant="soft" onClick={close}>
                  Close
                </Button>
                {onOpenWebsites && (
                  <Button type="button" variant="soft" onClick={onOpenWebsites}>
                    Open in Websites
                  </Button>
                )}
                <Button type="button" onClick={() => useDeployExposeStore.getState().clear(key)}>
                  Try again
                </Button>
              </>
            )}
            {phase === 'done' && (
              <>
                {onOpenWebsites && (
                  <Button type="button" variant="soft" onClick={onOpenWebsites}>
                    Open in Websites
                  </Button>
                )}
                <Button type="button" onClick={close}>
                  Done
                </Button>
              </>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
