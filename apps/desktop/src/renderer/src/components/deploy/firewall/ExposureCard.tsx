import type {
  ContainerPortInfo,
  ExposureFirewall,
  ExposureInventory,
  ExposureScope,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { Globe, Lock, NetworkIcon, Server, TriangleAlert } from '@/components/icons';
import { Chip, FOOTER_HAIRLINE, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { EXPOSURE_FIREWALL_LABEL, SCOPE_LABEL } from '@/lib/deploy/firewall/format';
import { cn } from '@/lib/utils';
import { CARD_BODY, RowsSkeleton, SecurityCard } from '../security/SecurityCard';
import { MakePrivateNotice, type MakePrivateOutcome } from './MakePrivate';

/**
 * What can be reached on the server: every listening socket and every port Docker publishes,
 * public or not, and what the firewall makes of it. A container published on all addresses
 * goes around the host firewall, so it is called out, with "make private": a Runova app is
 * redeployed with the service on 127.0.0.1, anything else is shown the change to make.
 */

export interface ExposureActions {
  serverId: string;
  canOperate: boolean;
  /** The container being looked up right now. */
  checking: string | null;
  /** Why the container could not be looked up. */
  problem: string | null;
  /** By container name, which a redeploy keeps while the id changes. */
  outcomes: Record<string, MakePrivateOutcome>;
  onMakePrivate: (port: ContainerPortInfo) => void;
}

function MakePrivateButton({
  port,
  actions,
}: {
  port: ContainerPortInfo;
  actions: ExposureActions | undefined;
}): React.JSX.Element {
  const allowed = actions?.canOperate === true;
  const checking = actions?.checking === port.containerId;
  const button = (
    <Button
      size="sm"
      variant="soft"
      disabled={!allowed || checking || actions?.checking !== null}
      onClick={() => actions?.onMakePrivate(port)}
    >
      <Lock className="h-3.5 w-3.5" /> Make private
    </Button>
  );
  return (
    <span className="ml-auto">
      {allowed ? (
        button
      ) : (
        <SimpleTooltip
          label="Making a container private needs the Operator role or higher."
          className="max-w-64"
          wrapTrigger
        >
          {button}
        </SimpleTooltip>
      )}
    </span>
  );
}

const SCOPE_ICON: Record<ExposureScope, typeof Globe> = {
  public: Globe,
  private: Server,
  local: Lock,
};

/** Who can reach it, and what the firewall makes of it, each in words with a mark. */
function Reach({ scope, firewall }: { scope: ExposureScope; firewall: ExposureFirewall }) {
  const Icon = SCOPE_ICON[scope];
  const risky = firewall === 'bypassed' || (scope === 'public' && firewall === 'off');
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Chip tone={scope === 'public' ? 'warning' : 'neutral'}>
        <Icon />
        {SCOPE_LABEL[scope]}
      </Chip>
      {risky ? (
        <Chip tone="destructive">
          <TriangleAlert />
          {EXPOSURE_FIREWALL_LABEL[firewall]}
        </Chip>
      ) : (
        <span className="text-xs text-muted-foreground">{EXPOSURE_FIREWALL_LABEL[firewall]}</span>
      )}
    </span>
  );
}

/** A labelled group of rows inside the card. */
function Group({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section aria-label={label} className={FOOTER_HAIRLINE}>
      <h4 className={cn(SECTION_HEADING, 'px-4 pb-1 pt-3')}>{label}</h4>
      {children}
    </section>
  );
}

const ROW = 'flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2';

export function ExposureCard({
  exposure,
  loading,
  error,
  actions,
}: {
  exposure: ExposureInventory | undefined;
  loading: boolean;
  error: string | null;
  actions?: ExposureActions;
}): React.JSX.Element {
  return (
    <SecurityCard
      icon={<NetworkIcon />}
      title="Exposure"
      description="What listens on the server, and who can reach it."
    >
      {loading && !exposure ? (
        <RowsSkeleton rows={2} />
      ) : !exposure ? (
        <p role="alert" className={cn(CARD_BODY, 'text-sm text-destructive')}>
          {error ?? 'What listens on the server could not be read.'}
        </p>
      ) : (
        <>
          <Group label="Listening ports">
            {exposure.socketsError ? (
              <p className="px-4 pb-3 text-sm text-destructive">{exposure.socketsError}</p>
            ) : (
              <ul className="settings-rows pb-1 text-sm">
                {exposure.sockets.map((socket) => (
                  <li key={`${socket.protocol}-${socket.address}-${socket.port}`} className={ROW}>
                    <span className="w-40 font-mono tabular-nums">
                      {socket.address.includes(':') ? `[${socket.address}]` : socket.address}:
                      {socket.port}/{socket.protocol}
                    </span>
                    <span className="w-28 truncate text-muted-foreground">
                      {socket.process ?? 'Unknown'}
                    </span>
                    <Reach scope={socket.scope} firewall={socket.firewall} />
                  </li>
                ))}
              </ul>
            )}
          </Group>
          <Group label="Container ports">
            {!exposure.dockerAvailable ? (
              <p className="px-4 pb-3 text-sm text-muted-foreground">
                {exposure.dockerError ?? 'Docker is not running on this server.'}
              </p>
            ) : exposure.containers.length === 0 ? (
              <p className="px-4 pb-3 text-sm text-muted-foreground">
                No container publishes a port.
              </p>
            ) : (
              <ul className="settings-rows pb-1 text-sm">
                {exposure.containers.some((port) => port.firewall === 'bypassed') && (
                  <li className="px-4 pb-2 text-xs text-muted-foreground">
                    Docker publishes these ports around the host firewall, so its rules do not apply
                    to them. Make them private to keep them on 127.0.0.1, then serve them through
                    Websites.
                  </li>
                )}
                {exposure.containers.map((port) => (
                  <li
                    key={`${port.containerId}-${port.hostAddress}-${port.hostPort}`}
                    aria-label={port.containerName}
                    className={ROW}
                  >
                    <span className="w-40 truncate font-medium">{port.containerName}</span>
                    <span className="w-40 font-mono text-xs tabular-nums">
                      {port.hostAddress}:{port.hostPort} to {port.containerPort}/{port.protocol}
                    </span>
                    <Reach scope={port.scope} firewall={port.firewall} />
                    {port.scope !== 'local' && <MakePrivateButton port={port} actions={actions} />}
                    {actions?.outcomes[port.containerName] &&
                      exposure.containers.find(
                        (other) => other.containerName === port.containerName,
                      ) === port && (
                        <MakePrivateNotice
                          serverId={actions.serverId}
                          outcome={actions.outcomes[port.containerName]}
                        />
                      )}
                  </li>
                ))}
              </ul>
            )}
            {actions?.problem && (
              <p role="alert" className="px-4 pb-3 text-xs text-destructive">
                {actions.problem}
              </p>
            )}
          </Group>
        </>
      )}
    </SecurityCard>
  );
}
