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
import {
  type ExposeStep,
  exposeOnDomain,
  initialExposeSteps,
  withStep,
} from '@/lib/deploy/sites/expose';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { ExposeStepList } from '../sites/ExposeSteps';
import { TextField, ToggleRow } from '../sites/fields';

/**
 * Puts one published port of an app on a domain: a site in Websites that forwards the domain to
 * the port on 127.0.0.1, nginx applied, then a certificate if asked for. The steps show as they
 * run, and a failed one keeps the form so the domain can be fixed and tried again.
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
  const [domain, setDomain] = useState('');
  const [certificate, setCertificate] = useState(true);
  const [websocket, setWebsocket] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [phase, setPhase] = useState<Phase>('form');
  const [steps, setSteps] = useState<ExposeStep[]>(initialExposeSteps);
  const [live, setLive] = useState('');
  const name = `${route.service}:${route.target}`;
  const working = phase === 'working';

  useEffect(() => {
    if (!open) return;
    setDomain('');
    setCertificate(true);
    setWebsocket(true);
    setError(undefined);
    setPhase('form');
    setSteps(initialExposeSteps());
  }, [open]);

  function check(): string | null {
    const checked = validateDomain(domain.trim());
    setError(checked.ok ? undefined : checked.reason);
    return checked.ok ? checked.value : null;
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (working) return;
    const value = check();
    if (!value) return;
    setDomain(value);
    setSteps(initialExposeSteps());
    setPhase('working');
    const outcome = await exposeOnDomain(
      {
        serverId,
        domain: value,
        service: `${route.stack}-${route.service}`,
        port: route.port,
        certificate,
        websocket,
      },
      (id, next) => setSteps((current) => withStep(current, id, next)),
    );
    setLive(value);
    setPhase(outcome.ok ? 'done' : 'failed');
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployWeb(serverId) });
  }

  const url = `${certificate ? 'https' : 'http'}://${live}`;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !working && onClose()}>
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
          <form className="space-y-1" onSubmit={(e) => void submit(e)}>
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
                  {certificate && (
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
                <Button type="button" variant="soft" onClick={onClose}>
                  Close
                </Button>
                {onOpenWebsites && (
                  <Button type="button" variant="soft" onClick={onOpenWebsites}>
                    Open in Websites
                  </Button>
                )}
                <Button type="button" onClick={() => setPhase('form')}>
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
                <Button type="button" onClick={onClose}>
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
