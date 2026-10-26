import {
  type AndroidDevice,
  type AndroidEmulator,
  type AndroidPhysicalDevice,
  bootStageLabel,
} from '@runova/core';
import { toast } from 'sonner';
import {
  Camera,
  EllipsisVertical,
  Play,
  RotateCw,
  Smartphone,
  StopCircle,
  Tablet,
  TerminalSquare,
  TriangleAlert,
  Upload,
  Video,
  Wifi,
} from '@/components/icons';
import { Chip, FOOTER_HAIRLINE, GLASS_CARD } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ResourceMeters } from './ResourceMeters';

/**
 * One device, virtual or physical.
 *
 * The card only offers what its state can actually do. A booting emulator shows the stage it is
 * at rather than a spinner, because a cold boot takes minutes and a silent spinner reads as a
 * hang. An unauthorized phone hides its actions entirely instead of greying them out: a wall of
 * disabled controls looks like the app is broken, when the fix is on the phone.
 */

const BOOTING_STATES = new Set(['launching', 'connecting', 'booting', 'finishing']);

/**
 * The card's parts. A state is marked with an inset ring rather than a tinted border, because
 * the app's global border colour wins over a border colour utility.
 */
const CARD_SHELL = cn(GLASS_CARD, 'flex flex-col transition-shadow');
const HEADER = 'p-4 pb-3';
const CONTENT = 'mt-auto px-4 pb-3 pt-0';
const FOOTER = cn('mt-auto gap-2 px-3 py-2.5', FOOTER_HAIRLINE);

/** The record button glows red while it is recording, so it is clear the screen is captured. */
function recordingButton(key: string, recording: boolean): string | undefined {
  return key === 'record' && recording ? 'bg-destructive/12 hover:bg-destructive/15' : undefined;
}

function DeviceGlyph({ device }: { device: string | null }): React.JSX.Element {
  const Icon = device?.includes('tablet') || device?.includes('pad') ? Tablet : Smartphone;
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
      <Icon className="h-4 w-4" />
    </div>
  );
}

function SerialChip({ serial }: { serial: string }): React.JSX.Element {
  return (
    <SimpleTooltip label="Copy serial">
      <button
        type="button"
        aria-label={`Copy serial ${serial}`}
        className="rounded-sm font-mono text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(serial);
          toast.success('Serial copied.');
        }}
      >
        {serial}
      </button>
    </SimpleTooltip>
  );
}

function BootProgress({ emulator }: { emulator: AndroidEmulator }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div
        className="h-[3px] overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-label="Boot progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={emulator.progress}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${emulator.progress}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{bootStageLabel(emulator.state)}</p>
    </div>
  );
}

export interface DeviceActionHandlers {
  onEdit: (avdName: string) => void;
  onColdBoot: (avdName: string) => void;
  onWipeData: (avdName: string) => void;
  onDelete: (avdName: string) => void;
  onScreenshot: (serial: string, label: string) => void;
  onToggleRecording: (serial: string, label: string) => void;
  onRotate: (serial: string) => void;
  onOpenShell: (serial: string, label: string) => void;
  onInstallApk: (serial: string, label: string) => void;
  /** The serial currently recording, so the button can show it is armed. */
  recordingSerial: string | null;
}

/**
 * The actions that are not worth a button of their own. Delete and Wipe both need the AVD's
 * folder to themselves, so they are disabled rather than hidden while it runs: a menu whose
 * items move around between states is harder to learn than one where they grey out.
 */
function DeviceMenu({
  avdName,
  running,
  actions,
}: {
  avdName: string;
  running: boolean;
  actions: DeviceActionHandlers;
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <SimpleTooltip label="More actions">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More actions">
            <EllipsisVertical className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => actions.onEdit(avdName)}>Edit</DropdownMenuItem>
        <DropdownMenuItem disabled={running} onSelect={() => actions.onColdBoot(avdName)}>
          Cold boot
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          tone="danger"
          disabled={running}
          onSelect={() => actions.onWipeData(avdName)}
        >
          Wipe data
        </DropdownMenuItem>
        <DropdownMenuItem
          tone="danger"
          disabled={running}
          onSelect={() => actions.onDelete(avdName)}
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface DeviceCardProps extends DeviceActionHandlers {
  device: AndroidDevice;
  pending: boolean;
  /** Ringed for a moment when a deep link points here. */
  focused?: boolean;
  cardRef?: (node: HTMLDivElement | null) => void;
  onStart: (avdName: string, options?: { coldBoot?: boolean; wipeData?: boolean }) => void;
  onStop: (serial: string) => void;
  onCancelBoot: (avdName: string) => void;
}

/**
 * The actions a device that is up can take. Icon only, because five labelled buttons would not
 * fit a card at phone width, so each one carries an aria-label and a tooltip instead.
 */
function DeviceActions({
  serial,
  label,
  actions,
}: {
  serial: string;
  label: string;
  actions: DeviceActionHandlers;
}): React.JSX.Element {
  const recording = actions.recordingSerial === serial;
  const buttons: { key: string; label: string; icon: React.ReactNode; onClick: () => void }[] = [
    {
      key: 'screenshot',
      label: 'Screenshot',
      icon: <Camera className="h-3.5 w-3.5" />,
      onClick: () => actions.onScreenshot(serial, label),
    },
    {
      key: 'record',
      label: recording ? 'Stop recording' : 'Record screen',
      icon: <Video className={cn('h-3.5 w-3.5', recording && 'text-destructive')} />,
      onClick: () => actions.onToggleRecording(serial, label),
    },
    {
      key: 'rotate',
      label: 'Rotate',
      icon: <RotateCw className="h-3.5 w-3.5" />,
      onClick: () => actions.onRotate(serial),
    },
    {
      key: 'shell',
      label: 'Open shell',
      icon: <TerminalSquare className="h-3.5 w-3.5" />,
      onClick: () => actions.onOpenShell(serial, label),
    },
    {
      key: 'install',
      label: 'Install APK',
      icon: <Upload className="h-3.5 w-3.5" />,
      onClick: () => actions.onInstallApk(serial, label),
    },
  ];

  return (
    <div className="ml-auto flex items-center gap-0.5">
      {buttons.map((button) => (
        <SimpleTooltip key={button.key} label={button.label}>
          <Button
            variant="ghost"
            size="icon-sm"
            className={recordingButton(button.key, recording)}
            aria-label={button.label}
            aria-pressed={button.key === 'record' ? recording : undefined}
            onClick={button.onClick}
          >
            {button.icon}
          </Button>
        </SimpleTooltip>
      ))}
    </div>
  );
}

function EmulatorCard({
  emulator,
  pending,
  onStart,
  onStop,
  onCancelBoot,
  focused,
  cardRef,
  ...actions
}: { emulator: AndroidEmulator } & Omit<DeviceCardProps, 'device'>): React.JSX.Element {
  const booting = BOOTING_STATES.has(emulator.state);
  const running = emulator.state === 'running';
  const failed = emulator.state === 'failed';

  return (
    <Card
      ref={cardRef}
      role="group"
      aria-label={emulator.avd.displayName}
      data-focused={focused ? 'true' : undefined}
      className={cn(
        CARD_SHELL,
        booting && 'ring-1 ring-inset ring-primary/35',
        failed && 'ring-1 ring-inset ring-destructive/40',
        focused && 'ring-2 ring-primary/60',
      )}
    >
      <CardHeader className={HEADER}>
        <div className="flex items-start gap-3">
          <DeviceGlyph device={emulator.avd.device} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight">
              {emulator.avd.displayName}
            </p>
            {emulator.serial ? (
              <SerialChip serial={emulator.serial} />
            ) : (
              <p className="truncate text-[11px] text-muted-foreground">{emulator.avd.name}</p>
            )}
          </div>
          <Chip
            tone={running ? 'success' : failed ? 'destructive' : booting ? 'primary' : 'neutral'}
            dot
            pulse={booting}
          >
            {running ? 'Running' : failed ? 'Failed' : booting ? 'Starting' : 'Stopped'}
          </Chip>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {[
            emulator.avd.api ? `API ${emulator.avd.api}` : null,
            emulator.avd.abi,
            emulator.avd.ramMb ? `${emulator.avd.ramMb} MB RAM` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </CardHeader>

      <CardContent className={cn(CONTENT, 'space-y-3')}>
        {booting && <BootProgress emulator={emulator} />}
        {running && emulator.usage && <ResourceMeters usage={emulator.usage} />}
        {failed && emulator.error && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
            {emulator.error}
          </p>
        )}
      </CardContent>

      <CardFooter className={FOOTER}>
        {booting ? (
          <Button
            variant="soft"
            size="sm"
            disabled={pending}
            onClick={() => onCancelBoot(emulator.avd.name)}
          >
            Cancel
          </Button>
        ) : running ? (
          <Button
            variant="soft"
            size="sm"
            disabled={pending}
            onClick={() => emulator.serial && onStop(emulator.serial)}
          >
            <StopCircle className="h-3.5 w-3.5" />
            Stop
          </Button>
        ) : (
          <Button size="sm" disabled={pending} onClick={() => onStart(emulator.avd.name)}>
            <Play className="h-3.5 w-3.5" />
            Start
          </Button>
        )}
        {running && emulator.serial && (
          <DeviceActions
            serial={emulator.serial}
            label={emulator.avd.displayName}
            actions={actions}
          />
        )}
        <div className={cn(!running && 'ml-auto')}>
          <DeviceMenu avdName={emulator.avd.name} running={running} actions={actions} />
        </div>
      </CardFooter>
    </Card>
  );
}

function PhysicalCard({
  device,
  focused,
  cardRef,
  ...actions
}: { device: AndroidPhysicalDevice } & DeviceActionHandlers & {
    focused?: boolean;
    cardRef?: (node: HTMLDivElement | null) => void;
  }): React.JSX.Element {
  const { state, serial, kind, model } = device.device;
  const ready = state === 'device';

  return (
    <Card
      ref={cardRef}
      role="group"
      aria-label={model ?? serial}
      data-focused={focused ? 'true' : undefined}
      className={cn(
        CARD_SHELL,
        !ready && 'ring-1 ring-inset ring-warning/40',
        focused && 'ring-2 ring-primary/60',
      )}
    >
      <CardHeader className={HEADER}>
        <div className="flex items-start gap-3">
          <DeviceGlyph device={null} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight">{model ?? serial}</p>
            <SerialChip serial={serial} />
          </div>
          <Chip tone={ready ? 'neutral' : 'warning'} dot={!ready}>
            {ready ? 'Physical' : state === 'unauthorized' ? 'Unauthorized' : 'Offline'}
          </Chip>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          {kind === 'wifi' && <Wifi className="h-3 w-3" />}
          {ready
            ? [
                device.androidVersion ? `Android ${device.androidVersion}` : null,
                device.api ? `API ${device.api}` : null,
                kind === 'wifi' ? 'Wi-Fi' : 'USB',
              ]
                .filter(Boolean)
                .join(' · ')
            : kind === 'wifi'
              ? 'Wi-Fi'
              : 'USB'}
        </p>
      </CardHeader>

      <CardContent className={CONTENT}>
        {!ready && (
          <p className="text-xs text-muted-foreground">
            {state === 'unauthorized'
              ? 'Check the phone for the "Allow USB debugging" prompt and tick "Always allow from this computer".'
              : 'The device is attached but not responding. Unplug it and plug it back in.'}
          </p>
        )}
      </CardContent>

      {ready && (
        <CardFooter className={FOOTER}>
          <DeviceActions serial={serial} label={model ?? serial} actions={actions} />
        </CardFooter>
      )}
    </Card>
  );
}

export function DeviceCard({ device, ...rest }: DeviceCardProps): React.JSX.Element {
  return device.kind === 'emulator' ? (
    <EmulatorCard emulator={device} {...rest} />
  ) : (
    <PhysicalCard device={device} {...rest} />
  );
}
