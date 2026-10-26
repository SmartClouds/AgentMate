import type { NginxStatus } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { Rocket, Server, Spinner, TriangleAlert } from '@/components/icons';
import { Chip, GLASS_CARD, TileHeader } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { relative } from '@/lib/deploy/sites/certificates';
import { cn } from '@/lib/utils';

/** nginx on the server: whether it is there, running and looked after by Runova. */

function Fact({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail: string;
}): React.JSX.Element {
  return (
    <li>
      <Chip tone={ok ? 'success' : 'neutral'} dot className="h-6 px-2.5">
        <span>{label}</span>
        {detail && <span className="opacity-70">{detail}</span>}
      </Chip>
    </li>
  );
}

export function NginxCard({
  status,
  loading,
  error,
  admin,
  installing,
  onInstall,
}: {
  status: NginxStatus | undefined;
  loading: boolean;
  error: string | null;
  admin: boolean;
  installing: boolean;
  onInstall: () => void;
}): React.JSX.Element {
  const action = status && !status.installed ? 'Install nginx' : 'Set up nginx for Runova';
  return (
    <section className={cn(GLASS_CARD, 'space-y-3 p-4')}>
      <div className="space-y-1">
        <TileHeader
          icon={<Server />}
          title="nginx"
          actions={
            admin && status && !status.managed ? (
              <Button type="button" size="sm" disabled={installing} onClick={onInstall}>
                {installing ? (
                  <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
                ) : (
                  <Rocket className="h-3.5 w-3.5" />
                )}
                {action}
              </Button>
            ) : undefined
          }
        />
        <p className="text-xs text-muted-foreground">
          {status?.version ? `Version ${status.version}` : 'The web server in front of your apps.'}
          {status?.fromNginxOrg ? ', from nginx.org' : ''}
        </p>
      </div>
      {loading ? (
        <div className="flex gap-1.5" aria-busy="true">
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-6 w-40 rounded-full" />
        </div>
      ) : error ? (
        <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <TriangleAlert className="h-3.5 w-3.5" /> {error}
        </p>
      ) : status ? (
        <>
          <ul aria-label="nginx" className="flex flex-wrap gap-1.5">
            <Fact
              ok={status.installed}
              label="Installed"
              detail={status.installed ? '' : 'not yet'}
            />
            <Fact
              ok={status.running}
              label={status.running ? 'Running' : 'Not running'}
              detail=""
            />
            <Fact
              ok={status.managed}
              label={status.managed ? 'Managed by Runova' : 'Not set up yet'}
              detail={status.currentRelease ? `release ${status.currentRelease}` : ''}
            />
          </ul>
          {!status.managed && (
            <p className="text-sm text-muted-foreground">
              {status.installed
                ? 'Runova can take over the nginx that is already here: it backs up and turns off the stock default site, and adds its own sites next to what you have.'
                : 'Runova installs nginx from the official nginx.org packages and sets it up for your sites.'}
              {admin ? '' : ' An Admin can do this.'}
            </p>
          )}
          {status.lastAppliedAtUnixMs && (
            <p className="text-xs text-muted-foreground">
              Last applied {relative(status.lastAppliedAtUnixMs, Date.now())}
              {status.lastAppliedBy ? ` by ${status.lastAppliedBy}` : ''}.
            </p>
          )}
          {!status.streamSupported && status.managed && (
            <p className="text-xs text-muted-foreground">
              This nginx was built without the stream module, so TCP and UDP proxies are not
              available.
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
