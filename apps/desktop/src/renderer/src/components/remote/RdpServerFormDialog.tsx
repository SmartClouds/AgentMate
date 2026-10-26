import type { RdpSavedServer, RdpServerOptions, SaveRdpServerInput } from '@shared/apiTypes';
import { DEFAULT_RDP_OPTIONS, DEFAULT_RDP_PORT, withRdpDefaults } from '@shared/rdpDefaults';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, Spinner } from '@/components/icons';
import { segmentClass } from '@/components/pageKit';
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
import { SecretInput } from '@/components/ui/secret-input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const RESOLUTIONS = [
  { value: 'fitWindow', label: 'Fit the window (follows resizing)' },
  { value: '1920x1080', label: '1920 × 1080' },
  { value: '1600x900', label: '1600 × 900' },
  { value: '1366x768', label: '1366 × 768' },
  { value: '1280x720', label: '1280 × 720' },
  { value: '1024x768', label: '1024 × 768' },
];

function resolutionValue(resolution: RdpServerOptions['resolution']): string {
  return resolution === 'fitWindow' ? 'fitWindow' : `${resolution.width}x${resolution.height}`;
}

function parseResolution(value: string): RdpServerOptions['resolution'] {
  if (value === 'fitWindow') return 'fitWindow';
  const [width, height] = value.split('x').map((n) => Number.parseInt(n, 10));
  return { width, height };
}

/**
 * How the session window opens. Stored as two flags (`fullscreenOnConnect` wins over
 * `maximizeOnConnect`), shown as one choice since only one of the three can apply.
 */
type OpenMode = 'window' | 'maximized' | 'fullscreen';

const OPEN_MODES: ReadonlyArray<{ value: OpenMode; label: string }> = [
  { value: 'window', label: 'Window' },
  { value: 'maximized', label: 'Maximized' },
  { value: 'fullscreen', label: 'Full screen' },
];

const OPEN_MODE_HINTS: Record<OpenMode, string> = {
  window: 'Opens a smaller window you can move and resize.',
  maximized: 'Fills the screen but keeps the Windows taskbar visible.',
  fullscreen:
    'Covers the whole screen. Press Ctrl+Alt+Break to switch between full screen and a window.',
};

function openModeOf(options: RdpServerOptions): OpenMode {
  if (options.fullscreenOnConnect) return 'fullscreen';
  return options.maximizeOnConnect ? 'maximized' : 'window';
}

function openModeOptions(
  mode: OpenMode,
): Pick<RdpServerOptions, 'fullscreenOnConnect' | 'maximizeOnConnect'> {
  return { fullscreenOnConnect: mode === 'fullscreen', maximizeOnConnect: mode === 'maximized' };
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <div className={cn('flex items-start justify-between gap-4', disabled && 'opacity-60')}>
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="mt-0.5"
      />
    </div>
  );
}

export interface RdpServerFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: RdpSavedServer;
  onSaved: (server: RdpSavedServer) => void;
}

export function RdpServerFormDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: RdpServerFormDialogProps): React.JSX.Element {
  const ids = useId();
  const [nickname, setNickname] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(DEFAULT_RDP_PORT));
  const [username, setUsername] = useState('');
  const [domain, setDomain] = useState('');
  const [secret, setSecret] = useState('');
  const [options, setOptions] = useState<RdpServerOptions>(DEFAULT_RDP_OPTIONS);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNickname(initial?.nickname ?? '');
    setHost(initial?.host ?? '');
    setPort(String(initial?.port ?? DEFAULT_RDP_PORT));
    setUsername(initial?.username ?? '');
    setDomain(initial?.domain ?? '');
    setSecret('');
    // A server saved by an older version lacks newer options, which would otherwise read as off.
    setOptions(withRdpDefaults(initial?.options));
    setShowAdvanced(false);
    setSubmitting(false);
  }, [open, initial]);

  const openMode = openModeOf(options);
  const keepsExistingSecret = initial?.hasSecret === true;
  const portNumber = Number.parseInt(port, 10);
  const canSubmit =
    nickname.trim().length > 0 &&
    host.trim().length > 0 &&
    username.trim().length > 0 &&
    Number.isInteger(portNumber) &&
    portNumber > 0 &&
    portNumber < 65536;

  function patchOptions(patch: Partial<RdpServerOptions>): void {
    setOptions((current) => ({ ...current, ...patch }));
  }

  // People often paste `DOMAIN\user` or `user@domain`; both sign in fine as typed, so the
  // separate domain field is only a hint.
  const usernameCarriesDomain = /[\\@]/.test(username);

  async function handleSubmit(): Promise<void> {
    if (!canSubmit || submitting) return;
    if (secret) {
      const status = await window.runova.ssh.vaultStatus();
      if (status.hasPasskey && !status.unlocked) {
        toast.error('Unlock your Servers passkey first (see the lock button above the list).');
        return;
      }
    }
    setSubmitting(true);
    try {
      const input: SaveRdpServerInput = {
        id: initial?.id,
        nickname: nickname.trim(),
        host: host.trim(),
        port: portNumber,
        username: username.trim(),
        domain: usernameCarriesDomain ? undefined : domain.trim() || undefined,
        secret: secret || undefined,
        options,
      };
      const saved = await window.runova.rdp.saveServer(input);
      onOpenChange(false);
      onSaved(saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save this server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md gap-0 overflow-hidden p-0"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void handleSubmit();
          }
        }}
      >
        <DialogHeader className="border-b border-border/70 px-6 py-5">
          <DialogTitle>
            {initial ? 'Edit Remote Desktop server' : 'Add Remote Desktop server'}
          </DialogTitle>
          <DialogDescription>
            A Windows Server or Windows PC with Remote Desktop turned on.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto px-6 py-5">
          <Field label="Nickname" htmlFor={`${ids}-nickname`}>
            <Input
              id={`${ids}-nickname`}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="File server"
            />
          </Field>
          <div className="grid grid-cols-[1fr_5.5rem] gap-3">
            <Field label="Computer" htmlFor={`${ids}-host`}>
              <Input
                id={`${ids}-host`}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.20 or server.example.com"
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            <Field label="Port" htmlFor={`${ids}-port`}>
              <Input
                id={`${ids}-port`}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username" htmlFor={`${ids}-username`}>
              <Input
                id={`${ids}-username`}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Administrator"
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            <Field label="Domain (optional)" htmlFor={`${ids}-domain`}>
              <Input
                id={`${ids}-domain`}
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder={usernameCarriesDomain ? 'In the username' : 'CONTOSO'}
                disabled={usernameCarriesDomain}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          </div>
          <Field
            label="Password"
            htmlFor={`${ids}-secret`}
            hint={keepsExistingSecret ? 'Leave blank to keep the current password.' : undefined}
          >
            <SecretInput
              id={`${ids}-secret`}
              value={secret}
              onChange={setSecret}
              placeholder={keepsExistingSecret ? 'Unchanged' : undefined}
            />
          </Field>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1.5 self-start text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', !showAdvanced && '-rotate-90')}
            />
            Display and sharing
          </button>

          {showAdvanced && (
            <div className="flex flex-col gap-4 rounded-lg border border-border/70 bg-secondary/20 p-4">
              <Field label="Resolution">
                <Combobox
                  options={RESOLUTIONS}
                  value={resolutionValue(options.resolution)}
                  onChange={(value) =>
                    value && patchOptions({ resolution: parseResolution(value) })
                  }
                  searchPlaceholder="Search resolutions…"
                />
              </Field>
              <Field label="Open as" hint={OPEN_MODE_HINTS[openMode]}>
                <div
                  role="radiogroup"
                  aria-label="Open as"
                  className="grid grid-cols-3 gap-0.5 rounded-full bg-foreground/8 p-0.5"
                >
                  {OPEN_MODES.map((mode) => (
                    <button
                      key={mode.value}
                      type="button"
                      role="radio"
                      aria-checked={openMode === mode.value}
                      onClick={() => patchOptions(openModeOptions(mode.value))}
                      className={cn(
                        segmentClass(openMode === mode.value),
                        'h-7 w-full px-2',
                        openMode === mode.value && 'text-primary',
                      )}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </Field>
              <ToggleRow
                id={`${ids}-clipboard`}
                label="Share clipboard"
                hint="Copy text and images here and paste them on the server, and the other way around."
                checked={options.clipboard}
                onChange={(checked) => patchOptions({ clipboard: checked })}
              />
              <ToggleRow
                id={`${ids}-files`}
                label="Copy files"
                hint={
                  options.clipboard
                    ? 'Copy files here and paste them on the server with Ctrl+V, and save files copied on the server.'
                    : 'Files are copied through the clipboard, so this needs clipboard sharing on.'
                }
                checked={options.clipboard && options.fileTransfer}
                disabled={!options.clipboard}
                onChange={(checked) => patchOptions({ fileTransfer: checked })}
              />
              <ToggleRow
                id={`${ids}-nla`}
                label="Network Level Authentication"
                hint="Signs in before the session starts. Windows Server requires it unless an admin turned it off."
                checked={options.nla}
                onChange={(checked) => patchOptions({ nla: checked })}
              />
            </div>
          )}
        </div>
        <DialogFooter className="items-center border-t border-border/70 bg-muted/20 px-6 py-4 sm:justify-between">
          <p className="text-xs text-muted-foreground">Ctrl+Enter to save</p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!canSubmit || submitting} onClick={() => void handleSubmit()}>
              {submitting && <Spinner className="h-4 w-4 animate-spin" />}
              {initial ? 'Save changes' : 'Add server'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
