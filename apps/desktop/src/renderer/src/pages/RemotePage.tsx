import { useState } from 'react';
import { Broadcast, Link, Monitor, Server } from '@/components/icons';
import { Chip, PillTabs, SECTION_HEADING } from '@/components/pageKit';
import { ControllerPanel } from '@/components/remote/ControllerPanel';
import { HostPanel } from '@/components/remote/HostPanel';
import { RdpServersPanel } from '@/components/remote/RdpServersPanel';
import { REMOTE_CARD } from '@/components/remote/remoteCard';
import { SshServersPanel } from '@/components/remote/SshServersPanel';
import { TransfersCard } from '@/components/remote/TransfersCard';
import { cn } from '@/lib/utils';
import { usePageHeader } from '@/stores/pageHeaderStore';
import { useRemoteStore } from '@/stores/remoteStore';

type RemoteTab = 'host' | 'connect' | 'ssh' | 'rdp';

const TAB_STORAGE_KEY = 'agentmate.remote.tab';
const REMOTE_TABS: readonly RemoteTab[] = ['host', 'connect', 'ssh', 'rdp'];

function readStoredTab(): RemoteTab {
  try {
    const stored = localStorage.getItem(TAB_STORAGE_KEY);
    return REMOTE_TABS.find((tab) => tab === stored) ?? 'host';
  } catch {
    return 'host';
  }
}

const LOG_DOT = {
  info: 'bg-muted-foreground/50',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-destructive',
} as const;

const LOG_TEXT = {
  info: 'text-foreground/85',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
} as const;

export default function RemotePage(): React.JSX.Element {
  const logs = useRemoteStore((s) => s.logs);
  const transfers = useRemoteStore((s) => s.transfers);
  const hosting = useRemoteStore((s) => s.state?.hosting ?? false);
  const connection = useRemoteStore((s) => s.state?.connection);
  const [activeTab, setActiveTab] = useState<RemoteTab>(readStoredTab);

  usePageHeader('Remote', 'Control another AgentMate over your local network, over WebSockets.');

  const connected = connection?.status === 'connected';
  const connecting = connection?.status === 'connecting';

  function openTab(tab: RemoteTab): void {
    setActiveTab(tab);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // Private mode and quota errors shouldn't block switching views.
    }
  }

  return (
    // Activity and transfers sit in a rail beside the view on a wide island, and below it on a
    // narrow one.
    <div className="@container/remote flex flex-1 flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
        <PillTabs<RemoteTab>
          id="remote-views"
          label="Remote views"
          value={activeTab}
          onChange={openTab}
          items={[
            { value: 'host', label: 'Host', icon: <Broadcast /> },
            { value: 'connect', label: 'Connect', icon: <Link /> },
            { value: 'ssh', label: 'SSH', icon: <Server /> },
            { value: 'rdp', label: 'Remote Desktop', icon: <Monitor /> },
          ]}
        />
        {/* What is live right now, whichever view is open. */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {hosting && (
            <Chip tone="success" dot>
              Hosting
            </Chip>
          )}
          {(connected || connecting) && (
            <Chip tone={connected ? 'success' : 'warning'} dot pulse={connecting}>
              {connected
                ? `Connected to ${connection?.remoteDeviceName ?? 'a remote device'}`
                : 'Connecting…'}
            </Chip>
          )}
        </div>
      </div>

      <div className="grid items-start gap-2 @4xl/remote:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0">
          {activeTab === 'host' && <HostPanel />}
          {activeTab === 'connect' && <ControllerPanel />}
          {activeTab === 'ssh' && <SshServersPanel />}
          {activeTab === 'rdp' && <RdpServersPanel />}
        </div>

        <div className="flex min-w-0 flex-col gap-2 @4xl/remote:sticky @4xl/remote:top-2">
          {transfers.length > 0 && (
            <TransfersCard
              title="File transfers"
              transfers={transfers}
              assumeVerified
              className="max-h-80"
            />
          )}

          <section aria-label="Activity" className={cn(REMOTE_CARD, 'flex max-h-[28rem] flex-col')}>
            <div className="flex h-9 shrink-0 items-center gap-2 px-4">
              <h2 className={SECTION_HEADING}>Activity</h2>
              {logs.length > 0 && (
                <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-muted-foreground">
                  {logs.length}
                </span>
              )}
            </div>
            {logs.length === 0 ? (
              <p className="px-4 pb-4 text-xs text-muted-foreground">Nothing yet.</p>
            ) : (
              <ul className="rail-scroll min-h-0 overflow-y-auto px-2 pb-2">
                {logs.map((log, i) => (
                  <li
                    key={`${log.at}-${i}`}
                    className="flex gap-2.5 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-foreground/[0.04]"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full',
                        LOG_DOT[log.level],
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block break-words leading-snug', LOG_TEXT[log.level])}>
                        {log.message}
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
                        {new Date(log.at).toLocaleTimeString()}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
