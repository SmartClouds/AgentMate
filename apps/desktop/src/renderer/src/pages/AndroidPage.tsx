import type { AndroidDevice, AndroidSdkStatus } from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ApkDropZone } from '@/components/android/ApkDropZone';
import { CreateAvdDialog } from '@/components/android/CreateAvdDialog';
import { DeviceCard } from '@/components/android/DeviceCard';
import { EditAvdDialog } from '@/components/android/EditAvdDialog';
import { SdkSetupPanel } from '@/components/android/SdkSetupPanel';
import { useAndroidActions } from '@/components/android/useAndroidActions';
import { useAndroidState } from '@/components/android/useAndroidState';
import { WirelessPairDialog } from '@/components/android/WirelessPairDialog';
import { Android, Copy, Plus, RefreshCw, Search, TriangleAlert, Wifi } from '@/components/icons';
import {
  CARD_GRID,
  CatalogCardShimmer,
  Chip,
  CountChip,
  EmptyState,
  GLASS_CARD,
  PillTabs,
  SearchPill,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { usePageHeader } from '@/stores/pageHeaderStore';

/** The SDK packages a card needs, named the way sdkmanager names them. */
const TOOL_PACKAGES: { key: keyof AndroidSdkStatus['tools']; label: string; pkg: string }[] = [
  { key: 'emulator', label: 'emulator', pkg: 'emulator' },
  { key: 'avdmanager', label: 'avdmanager', pkg: 'cmdline-tools;latest' },
  { key: 'sdkmanager', label: 'sdkmanager', pkg: 'cmdline-tools;latest' },
];

const VIEWS = ['All', 'Running', 'Virtual', 'Physical'] as const;
type View = (typeof VIEWS)[number];

/** The device grid, one shimmering card per slot until the first snapshot lands. */
function DeviceGridSkeleton(): React.JSX.Element {
  return (
    <div className="@container/grid">
      <div className={CARD_GRID} role="status" aria-label="Loading devices">
        {Array.from({ length: 6 }, (_, i) => (
          <CatalogCardShimmer key={i} className="h-44" />
        ))}
      </div>
    </div>
  );
}

/** Names the packages that are missing, so a partial SDK is a to-do rather than a mystery. */
function PartialSdkBanner({ sdk }: { sdk: AndroidSdkStatus }): React.JSX.Element | null {
  const missing = TOOL_PACKAGES.filter((tool) => !sdk.tools[tool.key]);
  if (missing.length === 0) return null;
  const packages = [...new Set(missing.map((tool) => tool.pkg))];
  const command = `sdkmanager ${packages.map((name) => `"${name}"`).join(' ')}`;

  return (
    <div
      className={cn(
        GLASS_CARD,
        'flex flex-wrap items-center gap-3 px-3.5 py-3 ring-1 ring-inset ring-warning/30',
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning/12 text-warning">
        <TriangleAlert className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">
          This SDK has no {missing.map((tool) => tool.label).join(', ')}
        </p>
        <p className="text-xs text-muted-foreground">
          Connected phones still work. Virtual devices need the missing packages, which you can
          install with <span className="font-mono">{command}</span>
        </p>
      </div>
      <Button
        variant="soft"
        onClick={() => {
          void navigator.clipboard.writeText(command);
          toast.success('Command copied.');
        }}
      >
        <Copy className="h-3.5 w-3.5" />
        Copy command
      </Button>
    </div>
  );
}

function matches(device: AndroidDevice, query: string): boolean {
  if (!query) return true;
  const haystack =
    device.kind === 'emulator'
      ? [device.avd.displayName, device.avd.name, device.serial ?? '']
      : [device.device.model ?? '', device.device.serial];
  return haystack.some((value) => value.toLowerCase().includes(query));
}

function inView(device: AndroidDevice, view: (typeof VIEWS)[number]): boolean {
  if (view === 'All') return true;
  if (view === 'Virtual') return device.kind === 'emulator';
  if (view === 'Physical') return device.kind === 'physical';
  return device.kind === 'emulator' ? device.state !== 'stopped' : device.device.state === 'device';
}

export default function AndroidPage(): React.JSX.Element {
  usePageHeader('Android', 'Run emulators, manage virtual devices and work with connected phones.');
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('All');
  const [creating, setCreating] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  /** A device asked for by the status bar link, waiting for the list to load. */
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const cardNodes = useRef(new Map<string, HTMLDivElement>());
  const bindCard = useCallback(
    (key: string) => (node: HTMLDivElement | null) => {
      if (node) cardNodes.current.set(key, node);
      else cardNodes.current.delete(key);
    },
    [],
  );

  const sdkQuery = useQuery({
    queryKey: queryKeys.androidSdk,
    queryFn: () => window.runova.android.sdk(),
    meta: { silentLoading: true },
  });

  // Another window (or the Settings card) can change the SDK path, so the page follows along
  // rather than showing a stale banner until the next manual refresh.
  useEffect(() => {
    return window.runova.android.onEvent((event) => {
      if (event.kind === 'sdk') queryClient.setQueryData(queryKeys.androidSdk, event.sdk);
    });
  }, [queryClient]);

  const setSdkPath = useMutation({
    mutationFn: (path: string | null) => window.runova.android.setSdkPath(path),
    onSuccess: (sdk) => {
      queryClient.setQueryData(queryKeys.androidSdk, sdk);
      if (sdk.status === 'found') toast.success('Android SDK found.');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const chooseFolder = async (): Promise<void> => {
    const picked = await window.runova.android.pickSdkPath();
    // A cancelled picker must not clear an override the user already has.
    if (picked) setSdkPath.mutate(picked);
  };

  const sdk = sdkQuery.data;
  const usable = sdk?.status === 'found';
  const state = useAndroidState(usable);
  const actions = useAndroidActions();

  const search = query.trim().toLowerCase();
  const visible = useMemo(
    () => state.devices.filter((device) => inView(device, view) && matches(device, search)),
    [state.devices, view, search],
  );

  // `/android?device=<serial>`, the link the status bar's Android panel opens. The search box is
  // cleared so the target cannot be hidden by whatever was typed last time, and the query string
  // is dropped once read so a later refresh does not jump around again.
  useEffect(() => {
    const serial = searchParams.get('device');
    if (!serial) return;
    setQuery('');
    setView('All');
    setSearchParams({}, { replace: true });
    setPendingFocus(serial);
  }, [searchParams, setSearchParams]);

  // Held off until a snapshot has actually arrived. An empty list before then means "not in
  // yet", not "gone", and the query does not even start until the SDK probe has answered, so
  // `loading` is false for that whole first stretch.
  useEffect(() => {
    if (!pendingFocus || !usable || !state.snapshot) return;
    const match = state.devices.find((device) =>
      device.kind === 'emulator'
        ? device.serial === pendingFocus
        : device.device.serial === pendingFocus,
    );
    setPendingFocus(null);
    if (!match) {
      toast.info('That device is no longer listed.');
      return;
    }
    const key = match.kind === 'emulator' ? match.avd.name : match.device.serial;
    setFocusedKey(key);
    const frame = requestAnimationFrame(() => {
      cardNodes.current.get(key)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingFocus, state.devices, state.snapshot, usable]);

  // The ring points at a card, it does not mark a state, so it fades on its own.
  useEffect(() => {
    if (focusedKey === null) return;
    const timer = setTimeout(() => setFocusedKey(null), 6000);
    return () => clearTimeout(timer);
  }, [focusedKey]);

  const runningCount = state.devices.filter(
    (device) => device.kind === 'emulator' && device.state === 'running',
  ).length;
  const virtualCount = state.devices.filter((device) => device.kind === 'emulator').length;
  const physicalCount = state.devices.filter((device) => device.kind === 'physical').length;
  /** What an APK can go onto right now: a booted emulator or a phone adb can reach. */
  const installTargets = state.devices.filter((device) =>
    device.kind === 'emulator'
      ? device.state === 'running' && device.serial !== null
      : device.device.state === 'device',
  );

  if (!sdk) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <Skeleton className="h-[5.5rem] w-full rounded-[calc(var(--radius)+2px)]" />
        <DeviceGridSkeleton />
      </div>
    );
  }

  if (!usable) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <SdkSetupPanel
          sdk={sdk}
          busy={sdkQuery.isFetching || setSdkPath.isPending}
          onChooseFolder={() => void chooseFolder()}
          onClearOverride={() => setSdkPath.mutate(null)}
          onRecheck={() => void sdkQuery.refetch()}
        />
      </div>
    );
  }

  const busy = state.fetching;
  const editTarget = state.devices.find(
    (device): device is Extract<typeof device, { kind: 'emulator' }> =>
      device.kind === 'emulator' && device.avd.name === editing,
  );

  return (
    <div className="flex flex-col gap-2 p-2">
      {/* One glass card heads the page: what is on this machine on top, and how to narrow it
          down and what to do next underneath, split by a hairline like the Settings rows. */}
      <div className={cn(GLASS_CARD, 'settings-rows')}>
        <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2">
          <CountChip label="Running" value={runningCount} tone="success" loading={state.loading} />
          <CountChip label="Virtual devices" value={virtualCount} loading={state.loading} />
          <CountChip label="Connected" value={physicalCount} loading={state.loading} />
          <div className="ml-auto flex items-center gap-1.5">
            <SimpleTooltip label={sdk.root ?? ''}>
              <Chip className="h-6 gap-1.5 px-2.5">
                <Android className="h-3 w-3" />
                <span className="tabular-nums">platform-tools {sdk.adbVersion ?? 'unknown'}</span>
              </Chip>
            </SimpleTooltip>
            <Button
              variant="soft"
              size="sm"
              disabled={busy}
              aria-busy={busy}
              onClick={state.refresh}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
          <SearchPill
            label="Search devices"
            placeholder="Search devices"
            value={query}
            onValueChange={setQuery}
            className="w-full min-w-44 max-w-64 flex-1"
          />
          <PillTabs
            id="android-views"
            label="Device views"
            items={VIEWS.map((item) => ({ value: item, label: item }))}
            value={view}
            onChange={setView}
          />
          <div className="ml-auto flex items-center gap-2">
            <Button variant="soft" onClick={() => setPairing(true)}>
              <Wifi className="h-3.5 w-3.5" />
              Pair over Wi-Fi
            </Button>
            {/* Never disabled. When avdmanager is missing the dialog says so and how to get it,
                which a greyed-out button never could. */}
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" />
              New device
            </Button>
          </div>
        </div>
      </div>

      <PartialSdkBanner sdk={sdk} />

      {state.loading ? (
        <DeviceGridSkeleton />
      ) : state.devices.length === 0 ? (
        <div className={GLASS_CARD}>
          <EmptyState
            size="lg"
            icon={Android}
            title="No devices yet"
            description="Virtual devices you create, and phones you plug in with USB debugging turned on, show up here."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus /> Create a virtual device
              </Button>
            }
          />
        </div>
      ) : visible.length === 0 ? (
        <div className={GLASS_CARD}>
          <EmptyState
            size="sm"
            icon={Search}
            title="Nothing to show"
            description={search ? `No devices match "${query.trim()}".` : 'Nothing in this view.'}
          />
        </div>
      ) : (
        <ApkDropZone
          targets={installTargets}
          onInstall={(serial, label, paths) => actions.installApk(serial, label, paths)}
          onReject={(message) => toast.error(message)}
          className="@container/grid"
        >
          <div className={CARD_GRID}>
            {visible.map((device) => {
              const key = device.kind === 'emulator' ? device.avd.name : device.device.serial;
              return (
                <DeviceCard
                  key={key}
                  device={device}
                  focused={focusedKey === key}
                  cardRef={bindCard(key)}
                  pending={actions.pending.has(key)}
                  onStart={actions.start}
                  onStop={actions.stop}
                  onCancelBoot={actions.cancelBoot}
                  onScreenshot={actions.screenshot}
                  onToggleRecording={actions.toggleRecording}
                  onRotate={actions.rotate}
                  onOpenShell={actions.openShell}
                  onInstallApk={actions.installApk}
                  onEdit={setEditing}
                  onColdBoot={actions.coldBoot}
                  onWipeData={actions.wipeData}
                  onDelete={actions.deleteAvd}
                  recordingSerial={actions.recordingSerial}
                />
              );
            })}
          </div>
        </ApkDropZone>
      )}

      <CreateAvdDialog
        open={creating}
        onOpenChange={setCreating}
        existingNames={state.devices
          .filter((device) => device.kind === 'emulator')
          .map((device) => (device.kind === 'emulator' ? device.avd.name : ''))}
        onCreated={() => state.refresh()}
        tools={sdk.tools}
      />
      <WirelessPairDialog open={pairing} onOpenChange={setPairing} />
      {editTarget ? (
        <EditAvdDialog
          open
          avd={editTarget.avd}
          running={editTarget.state === 'running'}
          onOpenChange={(next) => !next && setEditing(null)}
          onSaved={() => state.refresh()}
        />
      ) : null}
    </div>
  );
}
