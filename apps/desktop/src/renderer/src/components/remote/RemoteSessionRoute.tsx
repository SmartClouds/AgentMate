import { useEffect, useState } from 'react';
import { SparklineChart } from '@/components/dashboard/SparklineChart';
import { Monitor, Send, Upload } from '@/components/icons';
import {
  MacTrafficLightsSpace,
  NativeCaptionButtons,
  type WindowControlsProps,
} from '@/components/layout/TitleBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useChartColors } from '@/lib/chartColors';
import { describeRemoteQuality, formatMbps } from '@/lib/remoteQuality';
import { type ControllerRtcState, subscribeControllerRtc } from '@/lib/rtcController';
import { isTitleBarBlankDoubleClick } from '@/lib/titleBar';
import { useRemoteStore } from '@/stores/remoteStore';
import { RemoteScreen } from './RemoteScreen';

const HISTORY_LENGTH = 40;

/**
 * Standalone render target for the remote-control session window (loaded at
 * `#/remote-session`, see `sessionWindow.ts` in main). No AppShell/sidebar,
 * just a full window dedicated to one connection, independently resizable,
 * maximizable, and fullscreenable by the OS. Only this window ever mounts
 * `RemoteScreen` / drives WebRTC as a controller (see the doc comment on
 * `isRemoteSessionWindow` in stores/remoteStore.ts for why).
 */
export default function RemoteSessionRoute(): React.JSX.Element {
  const connection = useRemoteStore((s) => s.state?.connection);
  const [rtc, setRtc] = useState<ControllerRtcState>({
    mode: 'idle',
    stream: null,
    cursor: null,
    quality: null,
  });
  const [history, setHistory] = useState<{ t: number; kbps: number }[]>([]);
  const [isMaximized, setIsMaximized] = useState(false);
  const chartColors = useChartColors();
  const isMac = window.runova.platform === 'darwin';

  useEffect(() => subscribeControllerRtc(setRtc), []);

  useEffect(() => {
    if (!rtc.quality) return;
    setHistory((prev) =>
      [...prev, { t: Date.now(), kbps: rtc.quality!.kbps }].slice(-HISTORY_LENGTH),
    );
  }, [rtc.quality]);

  useEffect(() => {
    window.runova.remoteSessionWindow.isMaximized().then(setIsMaximized);
    return window.runova.remoteSessionWindow.onMaximizedChange(setIsMaximized);
  }, []);

  const status = connection?.status ?? 'idle';
  const connected = status === 'connected';
  const failed = status === 'error';
  // 'idle' here means the host went away mid-session (an explicit Disconnect
  // closes this window instead of leaving it around); the window stays open
  // so the operator can see what happened rather than losing the view.
  const statusBadge =
    status === 'connected'
      ? { label: 'Connected', variant: 'success' as const }
      : status === 'connecting'
        ? { label: 'Connecting…', variant: 'warning' as const }
        : status === 'error'
          ? { label: 'Failed', variant: 'destructive' as const }
          : { label: 'Disconnected', variant: 'secondary' as const };

  const controlProps: WindowControlsProps = {
    isMaximized,
    onMinimize: () => void window.runova.remoteSessionWindow.minimize(),
    onMaximizeToggle: () => void window.runova.remoteSessionWindow.maximizeToggle(),
    onClose: () => void window.runova.remoteSessionWindow.close(),
  };

  const quality = rtc.quality;
  const qualityInfo = quality ? describeRemoteQuality(quality) : null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <div
        className="relative flex h-11 shrink-0 items-center gap-3 border-b border-border pl-4 pr-2 [-webkit-app-region:drag]"
        onDoubleClick={(e) => {
          if (isTitleBarBlankDoubleClick(e))
            void window.runova.remoteSessionWindow.maximizeToggle();
        }}
      >
        <div className="flex shrink-0 items-center gap-2">
          {isMac && <MacTrafficLightsSpace />}
          <Monitor className="h-4 w-4 shrink-0 text-primary" />
          <span className="max-w-[160px] truncate text-sm font-semibold text-foreground">
            {connection?.remoteDeviceName ?? 'Remote device'}
          </span>
          <Badge variant={statusBadge.variant} className="shrink-0 gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {statusBadge.label}
          </Badge>
        </div>

        {/* Closing this window (the caption button at the far right) is the
            only way to end the session; a separate Disconnect button here
            would be redundant with it. */}
        <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
          <Button
            size="sm"
            variant="soft"
            disabled={!connected}
            onClick={() => void window.runova.remote.sendClipboard()}
          >
            <Send className="h-3.5 w-3.5" /> Clipboard
          </Button>
          <Button
            size="sm"
            variant="soft"
            disabled={!connected}
            onClick={() => void window.runova.remote.sendFile()}
          >
            <Upload className="h-3.5 w-3.5" /> Send file
          </Button>
          {connection?.remoteScreen && (
            <span className="whitespace-nowrap px-1 text-xs text-muted-foreground">
              {connection.remoteScreen.width}×{connection.remoteScreen.height}
            </span>
          )}
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 [-webkit-app-region:no-drag]">
          {qualityInfo && quality && (
            <>
              <Badge variant={qualityInfo.variant} className="shrink-0">
                {qualityInfo.label}
              </Badge>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                {formatMbps(quality.kbps)} · {quality.rttMs ?? '–'} ms · {quality.fps} fps
              </span>
              {history.length > 1 && (
                <SparklineChart
                  className="w-24 shrink-0"
                  height={24}
                  timestamps={history.map((h) => h.t)}
                  series={[
                    {
                      key: 'kbps',
                      label: 'Bandwidth',
                      color: chartColors.blue,
                      values: history.map((h) => h.kbps),
                    },
                  ]}
                  formatValue={(v) => formatMbps(v)}
                />
              )}
            </>
          )}
        </div>

        {!isMac && <NativeCaptionButtons {...controlProps} />}
      </div>

      {failed && connection?.error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {connection.error}
        </div>
      )}

      <RemoteScreen screen={connection?.remoteScreen ?? null} live={connected} />
    </div>
  );
}
