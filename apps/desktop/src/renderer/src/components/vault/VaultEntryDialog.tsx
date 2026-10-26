import type {
  SaveVaultEntryInput,
  VaultEntry,
  VaultEntrySummary,
  VaultEntryType,
} from '@runova/core';
import { vaultErrorMessage } from '@shared/vaultErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Spinner, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { EntryAvatar } from './EntryAvatar';
import { ENTRY_TYPE_META, ENTRY_TYPE_ORDER } from './entryTypes';
import { PasswordGeneratorPopover } from './PasswordGeneratorPopover';
import { PasswordStrengthMeter } from './PasswordStrengthMeter';
import { TagInput } from './TagInput';

export type VaultEntryDialogTarget =
  | { mode: 'new'; type?: VaultEntryType; title?: string }
  | { mode: 'edit'; id: string };

interface DraftField {
  key: string;
  id?: string;
  label: string;
  value: string;
  concealed: boolean;
}

interface Draft {
  type: VaultEntryType;
  title: string;
  tags: string[];
  favorite: boolean;
  notes: string;
  username: string;
  password: string;
  urls: string[];
  totpSecret: string;
  service: string;
  keyId: string;
  secret: string;
  expiresOn: string;
  fields: DraftField[];
  /** Favicon data URL for the first website, or null for the letter tile. */
  icon: string | null;
}

let fieldKey = 0;
const nextFieldKey = () => `field-${++fieldKey}`;

function emptyDraft(type: VaultEntryType = 'login', title = ''): Draft {
  return {
    type,
    title,
    tags: [],
    favorite: false,
    notes: '',
    username: '',
    password: '',
    urls: [''],
    totpSecret: '',
    service: '',
    keyId: '',
    secret: '',
    expiresOn: '',
    fields: [],
    icon: null,
  };
}

function toDateInput(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toISOString().slice(0, 10);
}

function draftFromEntry(entry: VaultEntry): Draft {
  const draft = {
    ...emptyDraft(entry.type, entry.title),
    tags: entry.tags,
    favorite: entry.favorite,
    icon: entry.icon ?? null,
  };
  draft.notes = entry.notes;
  if (entry.type === 'login') {
    Object.assign(draft, {
      username: entry.username,
      password: entry.password,
      urls: entry.urls.length ? entry.urls : [''],
      totpSecret: entry.totpSecret,
    });
  } else if (entry.type === 'apiKey') {
    Object.assign(draft, {
      service: entry.service,
      keyId: entry.keyId,
      secret: entry.secret,
      urls: entry.urls.length ? entry.urls : [''],
      expiresOn: toDateInput(entry.expiresAt),
    });
  } else if (entry.type === 'custom') {
    draft.fields = entry.fields.map((field) => ({ ...field, key: nextFieldKey() }));
  }
  return draft;
}

/** Leaves a secret out (undefined) when editing and it wasn't changed, so main keeps its copy. */
function changed(value: string, original: string | undefined): string | undefined {
  return original !== undefined && value === original ? undefined : value;
}

function buildInput(draft: Draft, original: Draft | null, id?: string): SaveVaultEntryInput {
  const base = {
    ...(id ? { id } : {}),
    title: draft.title.trim(),
    tags: draft.tags,
    favorite: draft.favorite,
    notes: changed(draft.notes, original?.notes),
    // null tells main to drop a stored icon; undefined leaves it alone.
    icon: original
      ? draft.icon === original.icon
        ? undefined
        : draft.icon
      : (draft.icon ?? undefined),
  };
  const urls = draft.urls.map((url) => url.trim()).filter(Boolean);
  switch (draft.type) {
    case 'login':
      return {
        ...base,
        type: 'login',
        username: draft.username,
        password: changed(draft.password, original?.password),
        urls,
        totpSecret: changed(draft.totpSecret, original?.totpSecret),
      };
    case 'apiKey':
      return {
        ...base,
        type: 'apiKey',
        service: draft.service,
        keyId: draft.keyId,
        secret: changed(draft.secret, original?.secret),
        urls,
        expiresAt: draft.expiresOn ? Date.parse(`${draft.expiresOn}T00:00:00Z`) : null,
      };
    case 'note':
      return { ...base, type: 'note' };
    case 'custom':
      return {
        ...base,
        type: 'custom',
        fields: draft.fields.map((field) => {
          const before = original?.fields.find((f) => f.id && f.id === field.id);
          return {
            ...(field.id ? { id: field.id } : {}),
            label: field.label.trim(),
            value: changed(field.value, before?.value),
            concealed: field.concealed,
          };
        }),
      };
  }
}

export function VaultEntryDialog({
  open,
  onOpenChange,
  target,
  knownTags,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: VaultEntryDialogTarget;
  knownTags: string[];
  onSaved?: (summary: VaultEntrySummary) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const editId = target.mode === 'edit' ? target.id : null;
  const formId = useId();
  const ids = {
    title: useId(),
    username: useId(),
    password: useId(),
    website: useId(),
    totp: useId(),
    service: useId(),
    keyId: useId(),
    secret: useId(),
    expires: useId(),
    notes: useId(),
    tags: useId(),
  };

  const entryQuery = useQuery({
    queryKey: queryKeys.vaultEntry(editId ?? ''),
    queryFn: () => window.runova.vault.getForEdit(editId as string),
    enabled: open && editId !== null,
    gcTime: 0,
    staleTime: 0,
    meta: { silentLoading: true },
  });

  const [draft, setDraft] = useState<Draft>(() =>
    target.mode === 'new' ? emptyDraft(target.type, target.title) : emptyDraft(),
  );
  const [baseline, setBaseline] = useState<Draft | null>(() =>
    target.mode === 'new' ? emptyDraft(target.type, target.title) : null,
  );
  const [showTotp, setShowTotp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);
  const [fetchingIcon, setFetchingIcon] = useState(false);
  // The address the last automatic fetch went to, so leaving the field again doesn't refetch it.
  const iconTriedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!editId || !entryQuery.data || loadedFor.current === editId) return;
    loadedFor.current = editId;
    const loaded = draftFromEntry(entryQuery.data);
    setDraft(loaded);
    setBaseline(loaded);
    setShowTotp(loaded.totpSecret !== '');
  }, [editId, entryQuery.data]);

  const loading = editId !== null && baseline === null;
  const dirty = baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline);
  const canSave = !loading && !saving && draft.title.trim() !== '';
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const strengthContext = useMemo(
    () => [draft.title, draft.username],
    [draft.title, draft.username],
  );

  async function requestClose(): Promise<void> {
    if (
      dirty &&
      !(await confirmDialog({
        title: 'Discard changes?',
        description: 'What you changed in this entry will be lost.',
        confirmLabel: 'Discard',
        variant: 'destructive',
      }))
    ) {
      return;
    }
    onOpenChange(false);
  }

  async function save(event?: React.FormEvent): Promise<void> {
    event?.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const input = buildInput(draft, editId ? baseline : null, editId ?? undefined);
      const saved = await window.runova.vault.save(input);
      void queryClient.invalidateQueries({ queryKey: queryKeys.vaultEntries });
      toast.success(editId ? 'Changes saved' : 'Entry added');
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      setError(vaultErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Downloads the first website's favicon. The automatic try on leaving the field stays quiet,
   * since plenty of sites have no icon; pressing the button asks for an answer either way.
   */
  async function fetchIcon(silent: boolean): Promise<void> {
    const url = draft.urls[0]?.trim() ?? '';
    if (!url || fetchingIcon) return;
    iconTriedFor.current = url;
    setFetchingIcon(true);
    try {
      const icon = await window.runova.vault.fetchIcon(url);
      if (!icon) {
        if (!silent) toast.error("Couldn't find an icon on that site.");
        return;
      }
      setDraft((current) => ({ ...current, icon }));
    } catch (err) {
      if (!silent) toast.error(vaultErrorMessage(err));
    } finally {
      setFetchingIcon(false);
    }
  }

  function handleWebsiteBlur(): void {
    const url = draft.urls[0]?.trim() ?? '';
    if (draft.icon || !url || iconTriedFor.current === url) return;
    void fetchIcon(true);
  }

  const iconControls = {
    hasIcon: draft.icon !== null,
    fetching: fetchingIcon,
    onFetch: () => void fetchIcon(false),
    onRemove: () => set('icon', null),
    onFirstBlur: handleWebsiteBlur,
  };

  function updateField(key: string, patch: Partial<DraftField>): void {
    set(
      'fields',
      draft.fields.map((field) => (field.key === key ? { ...field, ...patch } : field)),
    );
  }

  const title = editId ? 'Edit entry' : 'New entry';

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : void requestClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Everything you enter is encrypted with your master password.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        ) : (
          <form
            id={formId}
            className="-mx-6 min-h-0 space-y-4 overflow-y-auto px-6 py-1"
            onSubmit={save}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void save();
              }
            }}
          >
            {!editId && (
              <div
                role="radiogroup"
                aria-label="Entry type"
                className="grid grid-cols-4 gap-1 rounded-lg border border-border bg-muted/40 p-1"
              >
                {ENTRY_TYPE_ORDER.map((type) => {
                  const meta = ENTRY_TYPE_META[type];
                  const selected = draft.type === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => set('type', type)}
                      className={cn(
                        'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                        selected
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <meta.icon className="h-3 w-3" />
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor={ids.title}>Title</Label>
              <div className="flex items-center gap-2">
                <EntryAvatar
                  entry={{
                    title: draft.title || '?',
                    host: '',
                    type: draft.type,
                    icon: draft.icon ?? undefined,
                  }}
                />
                <Input
                  id={ids.title}
                  value={draft.title}
                  onChange={(e) => set('title', e.target.value)}
                  placeholder={
                    draft.type === 'apiKey' ? 'e.g. Stripe production' : 'e.g. GitHub, bank, router'
                  }
                  autoFocus
                />
              </div>
            </div>

            {draft.type === 'login' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={ids.username}>Username or email</Label>
                  <Input
                    id={ids.username}
                    value={draft.username}
                    onChange={(e) => set('username', e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={ids.password}>Password</Label>
                  <SecretInput
                    id={ids.password}
                    value={draft.password}
                    onChange={(value) => set('password', value)}
                    trailing={
                      <PasswordGeneratorPopover onUse={(value) => set('password', value)} />
                    }
                  />
                  <PasswordStrengthMeter password={draft.password} context={strengthContext} />
                </div>
                <UrlFields
                  firstId={ids.website}
                  urls={draft.urls}
                  onChange={(urls) => set('urls', urls)}
                  icon={iconControls}
                />
                {showTotp || draft.totpSecret ? (
                  <div className="space-y-1.5">
                    <Label htmlFor={ids.totp}>Authenticator key</Label>
                    <SecretInput
                      id={ids.totp}
                      value={draft.totpSecret}
                      onChange={(value) => set('totpSecret', value)}
                      placeholder="Setup key or otpauth:// link"
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline"
                    onClick={() => setShowTotp(true)}
                  >
                    Add an authenticator key
                  </button>
                )}
              </>
            )}

            {draft.type === 'apiKey' && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={ids.service}>Service</Label>
                    <Input
                      id={ids.service}
                      value={draft.service}
                      onChange={(e) => set('service', e.target.value)}
                      placeholder="e.g. OpenAI"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={ids.keyId}>Key ID</Label>
                    <Input
                      id={ids.keyId}
                      value={draft.keyId}
                      onChange={(e) => set('keyId', e.target.value)}
                      placeholder="Public part, if any"
                      className="font-mono"
                      spellCheck={false}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={ids.secret}>Secret</Label>
                  <SecretInput
                    id={ids.secret}
                    value={draft.secret}
                    onChange={(value) => set('secret', value)}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  <UrlFields
                    firstId={ids.website}
                    urls={draft.urls}
                    onChange={(urls) => set('urls', urls)}
                    icon={iconControls}
                    single
                  />
                  <div className="space-y-1.5">
                    <Label htmlFor={ids.expires}>Expires</Label>
                    <Input
                      id={ids.expires}
                      type="date"
                      value={draft.expiresOn}
                      onChange={(e) => set('expiresOn', e.target.value)}
                    />
                  </div>
                </div>
              </>
            )}

            {draft.type === 'custom' && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Fields</p>
                {draft.fields.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Add a field for each value, like a PIN, a license key or a recovery phrase.
                  </p>
                )}
                {draft.fields.map((field, index) => {
                  const n = index + 1;
                  return (
                    <div
                      key={field.key}
                      className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto_auto] items-center gap-2"
                    >
                      <Input
                        aria-label={`Field ${n} name`}
                        placeholder="Name"
                        value={field.label}
                        onChange={(e) => updateField(field.key, { label: e.target.value })}
                      />
                      {field.concealed ? (
                        <SecretInput
                          aria-label={`Field ${n} value`}
                          placeholder="Value"
                          value={field.value}
                          onChange={(value) => updateField(field.key, { value })}
                        />
                      ) : (
                        <Input
                          aria-label={`Field ${n} value`}
                          placeholder="Value"
                          value={field.value}
                          onChange={(e) => updateField(field.key, { value: e.target.value })}
                        />
                      )}
                      <SimpleTooltip
                        label={field.concealed ? 'Hidden until revealed' : 'Shown in the details'}
                      >
                        <Switch
                          aria-label={`Hide field ${n}`}
                          checked={field.concealed}
                          onCheckedChange={(concealed) => updateField(field.key, { concealed })}
                        />
                      </SimpleTooltip>
                      <SimpleTooltip label="Remove field">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove field ${n}`}
                          onClick={() =>
                            set(
                              'fields',
                              draft.fields.filter((f) => f.key !== field.key),
                            )
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </SimpleTooltip>
                    </div>
                  );
                })}
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  onClick={() =>
                    set('fields', [
                      ...draft.fields,
                      { key: nextFieldKey(), label: '', value: '', concealed: true },
                    ])
                  }
                >
                  <Plus className="h-3 w-3" />
                  Add field
                </Button>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor={ids.notes}>{draft.type === 'note' ? 'Note' : 'Notes'}</Label>
              <Textarea
                id={ids.notes}
                value={draft.notes}
                onChange={(e) => set('notes', e.target.value)}
                rows={draft.type === 'note' ? 8 : 3}
                spellCheck={false}
                placeholder={
                  draft.type === 'note'
                    ? 'Recovery codes, Wi-Fi passwords, anything private'
                    : 'Only shown when you ask for it'
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={ids.tags}>Tags</Label>
              <TagInput
                id={ids.tags}
                value={draft.tags}
                onChange={(tags) => set('tags', tags)}
                suggestions={knownTags}
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </form>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch
              aria-label="Favorite"
              checked={draft.favorite}
              onCheckedChange={(favorite) => set('favorite', favorite)}
              disabled={loading}
            />
            Pin to favorites
          </label>
          <div className="flex gap-2">
            <Button type="button" variant="soft" onClick={() => void requestClose()}>
              Cancel
            </Button>
            <Button type="submit" form={formId} disabled={!canSave}>
              {saving && <Spinner className="h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface IconControls {
  hasIcon: boolean;
  fetching: boolean;
  onFetch: () => void;
  onRemove: () => void;
  onFirstBlur: () => void;
}

function UrlFields({
  firstId,
  urls,
  onChange,
  icon,
  single = false,
}: {
  firstId: string;
  urls: string[];
  onChange: (urls: string[]) => void;
  icon: IconControls;
  single?: boolean;
}): React.JSX.Element {
  const shown = single ? urls.slice(0, 1) : urls;
  const linkClass =
    'inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-50';
  return (
    <div className="space-y-1.5">
      <Label htmlFor={firstId}>Website</Label>
      {shown.map((url, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            id={index === 0 ? firstId : undefined}
            aria-label={index === 0 ? undefined : `Website ${index + 1}`}
            value={url}
            placeholder="example.com/login"
            spellCheck={false}
            onChange={(e) => onChange(urls.map((u, i) => (i === index ? e.target.value : u)))}
            onBlur={index === 0 ? icon.onFirstBlur : undefined}
          />
          {index > 0 && (
            <SimpleTooltip label="Remove website">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                aria-label={`Remove website ${index + 1}`}
                onClick={() => onChange(urls.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </SimpleTooltip>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {!single && (
          <button type="button" className={linkClass} onClick={() => onChange([...urls, ''])}>
            Add another website
          </button>
        )}
        {icon.hasIcon ? (
          <button type="button" className={linkClass} onClick={icon.onRemove}>
            Remove site icon
          </button>
        ) : (
          <button
            type="button"
            className={linkClass}
            disabled={!urls[0]?.trim() || icon.fetching}
            onClick={icon.onFetch}
          >
            {icon.fetching && <Spinner className="h-3 w-3 animate-spin" />}
            Use site icon
          </button>
        )}
      </div>
    </div>
  );
}
