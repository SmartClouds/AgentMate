import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Broadcast,
  Copy,
  Monitor,
  Power,
  QrCode,
  Send,
  TriangleAlert,
  Upload,
  Users,
} from '@/components/icons';
import { Chip, EmptyState, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { describeHostQuality, formatMbps } from '@/lib/remoteQuality';
import { type HostQualitySnapshot, subscribeHostQuality } from '@/lib/rtcHost';
import { cn } from '@/lib/utils';
import { useRemoteStore } from '@/stores/remoteStore';
import { REMOTE_CARD, RemoteCardHeader, RemoteRow } from './remoteCard';

export function HostPanel(): React.JSX.Element {
  const state = useRemoteStore((s) => s.state);
  const [ip, setIp] = useState('');
  const [port, setPort] = useState(7900);
  const [generating, setGenerating] = useState(false);

  const interfaces = useMemo(() => state?.interfaces ?? [], [state?.interfaces]);
  const hosting = state?.hosting ?? false;
  const inputSupported = state?.inputSupported ?? false;
  const peers = state?.peers ?? [];
  const [quality, setQuality] = useState<HostQualitySnapshot | null>(null);

  useEffect(() => subscribeHostQuality(setQuality), []);

  // Default the interface selection to the first (LAN-preferred) address.
  useEffect(() => {
    if (!ip && interfaces.length > 0) setIp(interfaces[0].address);
  }, [interfaces, ip]);

  const options = useMemo(
    () => interfaces.map((i) => ({ value: i.address, label: `${i.address}  ·  ${i.name}` })),
    [interfaces],
  );

  async function toggleHosting(): Promise<void> {
    if (hosting) {
      await window.runova.remote.stopHost();
    } else {
      if (!ip) {
        toast.error('Pick an IP address to host on.');
        return;
      }
      await window.runova.remote.startHost({ ip, port });
    }
  }

  async function generateCode(): Promise<void> {
    setGenerating(true);
    try {
      await window.runova.remote.generatePairingCode();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  function copyCode(): void {
    if (!state?.pairing) return;
    void navigator.clipboard.writeText(state.pairing.code);
    toast.success('Pairing code copied.');
  }

  const pairing = state?.pairing ?? null;
  const hostQuality = peers.length > 0 && quality ? describeHostQuality(quality) : null;

  return (
    <div className="flex flex-col gap-2">
      <section className={REMOTE_CARD}>
        <RemoteCardHeader
          icon={Broadcast}
          title="Allow this machine to be controlled"
          description="Bind a WebSocket server to one of your network addresses, then share a one-time code so another Runova can connect and control this device."
        />
        <div className={cn('settings-rows', FOOTER_HAIRLINE)}>
          <RemoteRow
            label="Network address"
            description="The address on your local network other devices reach this one at."
            control={
              <Combobox
                ariaLabel="Network address"
                className="w-64"
                options={options}
                value={ip}
                onChange={setIp}
                placeholder={options.length ? 'Select an IP…' : 'No network interfaces found'}
                disabled={hosting || options.length === 0}
              />
            }
          />
          <RemoteRow
            label="Port"
            description="Between 1024 and 65535."
            control={
              <Input
                type="number"
                aria-label="Port"
                value={port}
                min={1024}
                max={65535}
                disabled={hosting}
                onChange={(e) => setPort(Number(e.target.value) || 7900)}
                className="w-28"
              />
            }
          />
          {!inputSupported && (
            <div className="flex items-start gap-2.5 bg-warning/[0.06] px-5 py-3 text-xs text-warning">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Keyboard/mouse control isn&apos;t available on this platform yet. Connected
                controllers will see the screen but can&apos;t drive it. Screen viewing, clipboard
                and file transfer still work.
              </span>
            </div>
          )}
          <RemoteRow
            label="Hosting"
            description={
              hosting
                ? 'Other devices on your network can pair with this one now.'
                : 'Off. Nothing is listening for connections.'
            }
            control={
              <>
                {hosting && (
                  <Chip tone="success" dot pulse>
                    Listening on {state?.hostIp}:{state?.hostPort}
                  </Chip>
                )}
                {hostQuality && quality && (
                  <Chip tone={hostQuality.variant}>
                    {hostQuality.label} · {formatMbps(quality.kbps)} · {quality.rttMs ?? '–'} ms
                  </Chip>
                )}
                <Button
                  onClick={() => void toggleHosting()}
                  variant={hosting ? 'destructive' : 'default'}
                  disabled={!ip && !hosting}
                >
                  <Power className="h-4 w-4" />
                  {hosting ? 'Stop hosting' : 'Start hosting'}
                </Button>
              </>
            }
          />
        </div>
      </section>

      {hosting && (
        <section className={REMOTE_CARD}>
          <RemoteCardHeader
            icon={QrCode}
            title="Pairing code"
            description="Each code contains a single-use token and expires shortly. Generate a fresh one for every connection."
          />
          <div className={cn('px-5 py-4', FOOTER_HAIRLINE)}>
            {pairing ? (
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                {/* The QR stays on white whatever the theme, or phones cannot read it. */}
                <img
                  src={pairing.qrDataUrl}
                  alt="Pairing QR code"
                  className="h-40 w-40 shrink-0 rounded-xl bg-white p-2 shadow-[0_0_40px_-16px_hsl(var(--primary)/0.6)]"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs text-muted-foreground">
                      Code (paste on the other device)
                    </p>
                    <Textarea
                      readOnly
                      spellCheck={false}
                      aria-label="Pairing code"
                      value={pairing.code}
                      onFocus={(e) => e.currentTarget.select()}
                      className="h-20 resize-none p-3 font-mono text-[11px] leading-tight"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={copyCode}>
                      <Copy className="h-3.5 w-3.5" /> Copy code
                    </Button>
                    <Button
                      variant="soft"
                      onClick={() => void generateCode()}
                      disabled={generating}
                    >
                      <QrCode className="h-3.5 w-3.5" /> New code
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <Button size="lg" onClick={() => void generateCode()} disabled={generating}>
                <QrCode className="h-4 w-4" /> Generate pairing code
              </Button>
            )}
          </div>
        </section>
      )}

      {hosting && (
        <section className={REMOTE_CARD}>
          <RemoteCardHeader
            icon={Users}
            title={`Connected controllers (${peers.length})`}
            actions={
              peers.length > 0 ? (
                <>
                  <Button variant="soft" onClick={() => void window.runova.remote.sendClipboard()}>
                    <Send className="h-3.5 w-3.5" /> Send clipboard
                  </Button>
                  <Button variant="soft" onClick={() => void window.runova.remote.sendFile()}>
                    <Upload className="h-3.5 w-3.5" /> Send file
                  </Button>
                </>
              ) : null
            }
          />
          <div className={FOOTER_HAIRLINE}>
            {peers.length === 0 ? (
              <EmptyState
                size="sm"
                icon={Users}
                title="Waiting for a controller"
                description="No one is connected yet. Share the pairing code above to let a device connect."
              />
            ) : (
              <ul className="settings-rows">
                {peers.map((peer) => (
                  <li key={peer.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground">
                      <Monitor className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{peer.deviceName}</span>
                    <span className="font-mono text-xs text-muted-foreground">{peer.address}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
