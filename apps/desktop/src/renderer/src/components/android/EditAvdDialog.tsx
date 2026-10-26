import {
  type AvdAdvanced,
  type AvdCamera,
  type AvdEdit,
  type AvdGpuMode,
  type AvdNetworkLatency,
  type AvdNetworkSpeed,
  type AvdSummary,
  androidVersionForApi,
} from '@runova/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Editing a device that already exists.
 *
 * An AVD's settings live in its own `config.ini`, so only what can be rewritten there is offered.
 * The system image and the device profile are shown but not editable: changing either needs the
 * AVD's folder rebuilt, and a control that silently does nothing is worse than an honest note.
 *
 * The advanced half mirrors Android Studio's own "Show Advanced Settings" panel, down to the
 * grouping, and writes the same keys. It is read from the file when it is opened rather than
 * guessed at, because a default written over something set in Studio would be a silent loss.
 */

/** What the emulator refuses to start below. Matched to the checks in core. */
const MIN_RAM_MB = 512;
const MIN_STORAGE_MB = 512;
const MIN_VM_HEAP_MB = 16;
const MAX_CORES = 16;

const GPU_OPTIONS: { value: AvdGpuMode; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'host', label: 'Hardware (host GPU)' },
  { value: 'swiftshader_indirect', label: 'Software' },
  { value: 'off', label: 'Off' },
];

const FRONT_CAMERA_OPTIONS: { value: AvdCamera; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'emulated', label: 'Emulated' },
  { value: 'webcam0', label: 'Webcam' },
];

/** Only the back camera gets the 3D room the emulator renders. */
const BACK_CAMERA_OPTIONS: { value: AvdCamera; label: string }[] = [
  ...FRONT_CAMERA_OPTIONS,
  { value: 'virtualscene', label: 'VirtualScene' },
];

const SPEED_OPTIONS: { value: AvdNetworkSpeed; label: string }[] = [
  { value: 'full', label: 'Full' },
  { value: 'hsdpa', label: 'HSDPA' },
  { value: 'umts', label: 'UMTS' },
  { value: 'edge', label: 'EDGE' },
  { value: 'gprs', label: 'GPRS' },
  { value: 'hscsd', label: 'HSCSD' },
  { value: 'gsm', label: 'GSM' },
];

const LATENCY_OPTIONS: { value: AvdNetworkLatency; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'umts', label: 'UMTS' },
  { value: 'edge', label: 'EDGE' },
  { value: 'gprs', label: 'GPRS' },
];

interface EditAvdDialogProps {
  open: boolean;
  avd: AvdSummary;
  /** A running emulator reads its config at start, so a change lands on the next one. */
  running: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

function describeImage(avd: AvdSummary): string {
  const version = androidVersionForApi(avd.api);
  const head =
    avd.api === null
      ? 'Unknown system image'
      : version
        ? `Android ${version} (API ${avd.api})`
        : `API ${avd.api}`;
  return [head, avd.abi].filter(Boolean).join(' · ');
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="glass space-y-3 rounded-xl p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

/** A labelled switch row, the shape the advanced panel uses for every yes/no setting. */
function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  min: number;
  step: number;
  onChange: (next: string) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function EditAvdDialog({
  open,
  avd,
  running,
  onOpenChange,
  onSaved,
}: EditAvdDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(avd.displayName);
  const [ram, setRam] = useState(String(avd.ramMb ?? ''));
  const [storage, setStorage] = useState(String(avd.storageMb ?? ''));
  const [gpu, setGpu] = useState<string>(avd.gpuMode ?? 'auto');

  /** Null until the file has been read, so nothing is saved over a value that was never loaded. */
  const [advanced, setAdvanced] = useState<AvdAdvanced | null>(null);
  const [vmHeap, setVmHeap] = useState('');
  const [cores, setCores] = useState('');
  const [sdCard, setSdCard] = useState('');

  // Only read once the panel is actually opened: most edits are a rename or a RAM bump.
  const configQuery = useQuery({
    queryKey: queryKeys.androidAvdConfig(avd.name),
    queryFn: () => window.runova.android.avdConfig(avd.name),
    enabled: open && showAdvanced,
    meta: { silentLoading: true },
  });

  // Reopening on a different device must not show the last one's numbers.
  useEffect(() => {
    if (!open) return;
    setName(avd.displayName);
    setRam(String(avd.ramMb ?? ''));
    setStorage(String(avd.storageMb ?? ''));
    setGpu(avd.gpuMode ?? 'auto');
    setShowAdvanced(false);
    setAdvanced(null);
    setError(null);
  }, [open, avd]);

  useEffect(() => {
    if (!configQuery.data) return;
    setAdvanced(configQuery.data);
    setVmHeap(String(configQuery.data.vmHeapMb ?? ''));
    setCores(String(configQuery.data.cores));
    setSdCard(String(configQuery.data.sdCardMb));
  }, [configQuery.data]);

  const ramMb = Number(ram);
  const storageMb = Number(storage);
  const vmHeapMb = Number(vmHeap);
  const coreCount = Number(cores);
  const sdCardMb = Number(sdCard);

  const problem =
    name.trim() === ''
      ? 'Give the device a name.'
      : ram !== '' && (!Number.isFinite(ramMb) || ramMb < MIN_RAM_MB)
        ? `RAM has to be at least ${MIN_RAM_MB} MB.`
        : storage !== '' && (!Number.isFinite(storageMb) || storageMb < MIN_STORAGE_MB)
          ? `Internal storage has to be at least ${MIN_STORAGE_MB} MB.`
          : vmHeap !== '' && (!Number.isFinite(vmHeapMb) || vmHeapMb < MIN_VM_HEAP_MB)
            ? `The VM heap has to be at least ${MIN_VM_HEAP_MB} MB.`
            : cores !== '' &&
                (!Number.isFinite(coreCount) || coreCount < 1 || coreCount > MAX_CORES)
              ? `Give it between 1 and ${MAX_CORES} cores.`
              : sdCard !== '' && (!Number.isFinite(sdCardMb) || sdCardMb < 0)
                ? 'An SD card cannot be negative.'
                : null;

  /** Only what moved, so an unchanged value never rewrites a line of config.ini. */
  const changes = (): AvdEdit => {
    const edit: AvdEdit = {};
    if (name.trim() !== avd.displayName) edit.displayName = name.trim();
    if (ram !== '' && ramMb !== avd.ramMb) edit.ramMb = ramMb;
    if (storage !== '' && storageMb !== avd.storageMb) edit.storageMb = storageMb;
    if (gpu !== (avd.gpuMode ?? 'auto')) edit.gpuMode = gpu as AvdGpuMode;

    // Nothing advanced can have changed before the file was read.
    if (!advanced) return edit;
    if (vmHeap !== '' && vmHeapMb !== advanced.vmHeapMb) edit.vmHeapMb = vmHeapMb;
    if (cores !== '' && coreCount !== advanced.cores) edit.cores = coreCount;
    if (sdCard !== '' && sdCardMb !== advanced.sdCardMb) edit.sdCardMb = sdCardMb;
    if (advanced.cameraFront !== configQuery.data?.cameraFront) {
      edit.cameraFront = advanced.cameraFront;
    }
    if (advanced.cameraBack !== configQuery.data?.cameraBack) edit.cameraBack = advanced.cameraBack;
    if (advanced.networkSpeed !== configQuery.data?.networkSpeed) {
      edit.networkSpeed = advanced.networkSpeed;
    }
    if (advanced.networkLatency !== configQuery.data?.networkLatency) {
      edit.networkLatency = advanced.networkLatency;
    }
    if (advanced.keyboard !== configQuery.data?.keyboard) edit.keyboard = advanced.keyboard;
    if (advanced.deviceFrame !== configQuery.data?.deviceFrame) {
      edit.deviceFrame = advanced.deviceFrame;
    }
    if (advanced.coldBootAlways !== configQuery.data?.coldBootAlways) {
      edit.coldBootAlways = advanced.coldBootAlways;
    }
    return edit;
  };

  const save = useMutation({
    mutationFn: () => window.runova.android.editAvd(avd.name, changes()),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.message ?? 'Could not save those settings.');
        return;
      }
      toast.success(`${name.trim()} updated.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.androidSnapshot });
      void queryClient.invalidateQueries({ queryKey: queryKeys.androidAvdConfig(avd.name) });
      onSaved();
      onOpenChange(false);
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const patch = (next: Partial<AvdAdvanced>): void => {
    setAdvanced((current) => (current ? { ...current, ...next } : current));
  };

  const nothingToDo = Object.keys(changes()).length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {avd.displayName}</DialogTitle>
          <DialogDescription>
            These are the settings this device reads when it starts.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 max-h-[55vh] space-y-4 overflow-y-auto px-1">
          <div className="space-y-1.5">
            <Label htmlFor="edit-avd-name">Name</Label>
            <Input
              id="edit-avd-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Only what you see it called. Its id stays{' '}
              <span className="font-mono">{avd.name}</span>.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <NumberField
              id="edit-avd-ram"
              label="RAM (MB)"
              value={ram}
              min={MIN_RAM_MB}
              step={256}
              onChange={setRam}
            />
            <NumberField
              id="edit-avd-storage"
              label="Internal storage (MB)"
              value={storage}
              min={MIN_STORAGE_MB}
              step={512}
              onChange={setStorage}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Graphics</Label>
            <Combobox options={GPU_OPTIONS} value={gpu} onChange={setGpu} />
          </div>

          <div className="glass space-y-1 rounded-xl p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              System image
            </p>
            <p className="text-sm">{describeImage(avd)}</p>
            <p className="text-xs text-muted-foreground">
              To run a different version of Android, delete this device and create a new one. There
              is no safe way to swap the image underneath an existing device.
            </p>
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start px-2"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((current) => !current)}
          >
            {showAdvanced ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {showAdvanced ? 'Hide advanced settings' : 'Show advanced settings'}
          </Button>

          {showAdvanced && !advanced ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-24 w-full rounded-xl" />
              ))}
            </div>
          ) : null}

          {showAdvanced && advanced ? (
            <div className="space-y-3">
              <Group title="Emulated performance">
                <NumberField
                  id="edit-avd-cores"
                  label="Multi-core CPU (cores)"
                  value={cores}
                  min={1}
                  step={1}
                  onChange={setCores}
                />
                <SwitchRow
                  id="edit-avd-coldboot"
                  label="Always cold boot"
                  hint="Ignore the saved snapshot and boot from scratch every time."
                  checked={advanced.coldBootAlways}
                  onChange={(next) => patch({ coldBootAlways: next })}
                />
              </Group>

              <Group title="Memory and storage">
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    id="edit-avd-heap"
                    label="VM heap (MB)"
                    value={vmHeap}
                    min={MIN_VM_HEAP_MB}
                    step={16}
                    onChange={setVmHeap}
                  />
                  <NumberField
                    id="edit-avd-sdcard"
                    label="SD card (MB)"
                    value={sdCard}
                    min={0}
                    step={128}
                    onChange={setSdCard}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Set the SD card to 0 for a device with no card at all.
                </p>
              </Group>

              <Group title="Camera">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Front</Label>
                    <Combobox
                      options={FRONT_CAMERA_OPTIONS}
                      value={advanced.cameraFront}
                      onChange={(next) => patch({ cameraFront: next as AvdCamera })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Back</Label>
                    <Combobox
                      options={BACK_CAMERA_OPTIONS}
                      value={advanced.cameraBack}
                      onChange={(next) => patch({ cameraBack: next as AvdCamera })}
                    />
                  </div>
                </div>
              </Group>

              <Group title="Network">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Speed</Label>
                    <Combobox
                      options={SPEED_OPTIONS}
                      value={advanced.networkSpeed}
                      onChange={(next) => patch({ networkSpeed: next as AvdNetworkSpeed })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Latency</Label>
                    <Combobox
                      options={LATENCY_OPTIONS}
                      value={advanced.networkLatency}
                      onChange={(next) => patch({ networkLatency: next as AvdNetworkLatency })}
                    />
                  </div>
                </div>
              </Group>

              <Group title="Device">
                <SwitchRow
                  id="edit-avd-keyboard"
                  label="Hardware keyboard"
                  hint="Type into the device with the keyboard on this computer."
                  checked={advanced.keyboard}
                  onChange={(next) => patch({ keyboard: next })}
                />
                <SwitchRow
                  id="edit-avd-frame"
                  label="Show the device frame"
                  hint="Draw the phone's bezel around the screen."
                  checked={advanced.deviceFrame}
                  onChange={(next) => patch({ deviceFrame: next })}
                />
              </Group>
            </div>
          ) : null}

          {running ? (
            <p className="text-xs text-warning">
              This device is running. The change takes effect the next time it starts.
            </p>
          ) : null}
          {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={problem !== null || nothingToDo || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
