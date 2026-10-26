import { hostOf, type VaultEntrySummary, type VaultFieldRef } from '@runova/core';
import { vaultErrorMessage } from '@shared/vaultErrors';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FilePlus,
  Pencil,
  Star,
  Tag,
  Trash2,
  TriangleAlert,
} from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { relativeDate } from '@/lib/vault/relativeDate';
import { EntryAvatar } from './EntryAvatar';
import { ENTRY_TYPE_META } from './entryTypes';
import { SecretText } from './SecretText';
import type { useVaultActions } from './useVaultActions';

/** How long a revealed value stays on screen before it masks itself again. */
export const REVEAL_MS = 20_000;
const MASK = '••••••••••••';
const DAY = 86_400_000;

function refKey(ref: VaultFieldRef): string {
  return typeof ref === 'string' ? ref : `field:${ref.customFieldId}`;
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label}>
      <Button type="button" variant="ghost" size="icon" aria-label={label} onClick={onClick}>
        {children}
      </Button>
    </SimpleTooltip>
  );
}

/** A group of rows inside the detail card: a faint inset well, hairlines between its rows. */
const ROWS_BOX =
  'settings-rows rounded-xl bg-foreground/[0.025] ring-1 ring-inset ring-foreground/[0.08]';

/** One field: its name on the left, the value beside it and the row's buttons on the right. */
function FieldRow({
  label,
  children,
  actions,
  hint,
}: {
  label: string;
  children: ReactNode;
  actions?: ReactNode;
  hint?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="group flex flex-wrap items-center gap-x-4 gap-y-0.5 px-4 py-2.5">
      <p className="w-28 shrink-0 text-xs text-muted-foreground">{label}</p>
      <div className="min-w-[min(100%,10rem)] flex-1">
        <div className="min-h-[1.5rem] break-words text-sm leading-6">{children}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

export function VaultDetailPane({
  entry,
  actions,
  onEdit,
  onTagClick,
  onBack,
}: {
  entry: VaultEntrySummary;
  actions: ReturnType<typeof useVaultActions>;
  onEdit: () => void;
  onTagClick: (tag: string) => void;
  onBack: () => void;
}): React.JSX.Element {
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  function hide(key: string): void {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setRevealed(({ [key]: _gone, ...rest }) => rest);
  }

  async function toggleReveal(ref: VaultFieldRef): Promise<void> {
    const key = refKey(ref);
    if (key in revealed) {
      hide(key);
      return;
    }
    try {
      const value = await window.runova.vault.reveal(entry.id, ref);
      setRevealed((current) => ({ ...current, [key]: value }));
      clearTimeout(timers.current.get(key));
      timers.current.set(
        key,
        setTimeout(() => hide(key), REVEAL_MS),
      );
    } catch (error) {
      toast.error('Could not show that value', { description: vaultErrorMessage(error) });
    }
  }

  function secretRow(ref: VaultFieldRef, label: string, hint?: ReactNode): React.JSX.Element {
    const key = refKey(ref);
    const shown = revealed[key];
    const name = label.toLowerCase();
    return (
      <FieldRow
        key={key}
        label={label}
        hint={hint}
        actions={
          <>
            <IconAction
              label={shown === undefined ? `Show ${name}` : `Hide ${name}`}
              onClick={() => void toggleReveal(ref)}
            >
              {shown === undefined ? (
                <Eye className="h-3.5 w-3.5" />
              ) : (
                <EyeOff className="h-3.5 w-3.5" />
              )}
            </IconAction>
            <IconAction
              label={`Copy ${name}`}
              onClick={() => void actions.copy(entry.id, ref, label)}
            >
              <Copy className="h-3.5 w-3.5" />
            </IconAction>
          </>
        }
      >
        {shown === undefined ? (
          <span className="font-mono tracking-widest text-muted-foreground">{MASK}</span>
        ) : (
          <SecretText value={shown} />
        )}
      </FieldRow>
    );
  }

  function plainRow(value: string, label: string, ref: VaultFieldRef): React.JSX.Element {
    return (
      <FieldRow
        key={refKey(ref)}
        label={label}
        actions={
          <IconAction
            label={`Copy ${label.toLowerCase()}`}
            onClick={() => void actions.copy(entry.id, ref, label)}
          >
            <Copy className="h-3.5 w-3.5" />
          </IconAction>
        }
      >
        <span className="select-text">{value}</span>
      </FieldRow>
    );
  }

  const rows: React.JSX.Element[] = [];
  if (entry.type === 'login') {
    if (entry.username) rows.push(plainRow(entry.username, 'Username', 'username'));
    if (entry.hasPassword) {
      const age =
        entry.passwordUpdatedAt !== null ? (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" />
            Changed {relativeDate(entry.passwordUpdatedAt)}
          </span>
        ) : undefined;
      rows.push(secretRow('password', 'Password', age));
    }
    if (entry.hasTotp) rows.push(secretRow('totpSecret', 'Authenticator key'));
  }
  if (entry.type === 'apiKey') {
    if (entry.service) {
      rows.push(
        <FieldRow key="service" label="Service">
          {entry.service}
        </FieldRow>,
      );
    }
    if (entry.keyId) rows.push(plainRow(entry.keyId, 'Key ID', 'keyId'));
    if (entry.hasSecret) rows.push(secretRow('secret', 'Secret'));
    if (entry.expiresAt !== null) {
      const expired = entry.expiresAt < Date.now();
      const soon = !expired && entry.expiresAt - Date.now() < 14 * DAY;
      rows.push(
        <FieldRow key="expires" label="Expires">
          <span
            className={cn((expired || soon) && 'inline-flex items-center gap-1.5 text-warning')}
          >
            {(expired || soon) && <TriangleAlert className="h-3 w-3" />}
            {new Date(entry.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
            <span className="text-muted-foreground">
              {' '}
              ({expired ? 'expired ' : ''}
              {relativeDate(entry.expiresAt)})
            </span>
          </span>
        </FieldRow>,
      );
    }
  }
  if (entry.type === 'login' || entry.type === 'apiKey') {
    for (const [index, url] of entry.urls.entries()) {
      const host = hostOf(url) || url;
      rows.push(
        <FieldRow
          key={`url-${index}`}
          label={entry.urls.length > 1 ? `Website ${index + 1}` : 'Website'}
          actions={
            <IconAction
              label={`Open ${host}`}
              onClick={() => void window.runova.shell.openExternal(url)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </IconAction>
          }
        >
          <span className="text-muted-foreground">{url}</span>
        </FieldRow>,
      );
    }
  }
  if (entry.type === 'custom') {
    for (const field of entry.fields) {
      const ref = { customFieldId: field.id };
      if (field.concealed) {
        if (field.hasValue) rows.push(secretRow(ref, field.label));
      } else {
        rows.push(plainRow(field.value ?? '', field.label, ref));
      }
    }
  }

  const notesShown = revealed.notes;
  const typeMeta = ENTRY_TYPE_META[entry.type];

  return (
    <section aria-label={entry.title} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3.5 px-5 py-4 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
        <Button
          variant="ghost"
          size="icon"
          className="-ml-2 @3xl/vault:hidden"
          aria-label="Back to the list"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <EntryAvatar entry={entry} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold leading-7 tracking-tight">{entry.title}</h2>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">
              <typeMeta.icon className="h-2.5 w-2.5" />
              {typeMeta.label}
            </span>
            {entry.host && <span className="truncate">{entry.host}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconAction
            label={entry.favorite ? 'Remove from favorites' : 'Add to favorites'}
            onClick={() => void actions.setFavorite(entry.id, !entry.favorite)}
          >
            <Star className={cn('h-3.5 w-3.5', entry.favorite && 'text-warning')} />
          </IconAction>
          <IconAction label="Duplicate" onClick={() => void actions.duplicate(entry.id)}>
            <FilePlus className="h-3.5 w-3.5" />
          </IconAction>
          <IconAction label="Delete" onClick={() => void actions.remove(entry)}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconAction>
          <Button className="ml-1.5" onClick={onEdit}>
            <Pencil className="h-3 w-3" />
            Edit
          </Button>
        </div>
      </div>

      <div className="rail-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {rows.length > 0 && (
          <div className="space-y-2">
            <h3 className={cn(SECTION_HEADING, 'px-1')}>Details</h3>
            <div className={ROWS_BOX}>{rows}</div>
          </div>
        )}

        {entry.hasNotes && (
          <div className="space-y-2">
            <h3 className={cn(SECTION_HEADING, 'px-1')}>
              {entry.type === 'note' ? 'Note' : 'Notes'}
            </h3>
            <div className={ROWS_BOX}>
              <div className="flex items-center gap-3 px-4 py-2.5">
                <p className="min-w-0 flex-1 text-sm">
                  {notesShown === undefined ? (
                    <span className="text-muted-foreground">
                      Hidden. Notes often hold recovery codes.
                    </span>
                  ) : (
                    <span className="block whitespace-pre-wrap break-words">{notesShown}</span>
                  )}
                </p>
                <div className="flex shrink-0 items-center gap-0.5 self-start">
                  <Button
                    variant="soft"
                    size="sm"
                    className="gap-1.5 px-2.5"
                    aria-label={notesShown === undefined ? 'Show notes' : 'Hide notes'}
                    onClick={() => void toggleReveal('notes')}
                  >
                    {notesShown === undefined ? (
                      <Eye className="h-3 w-3" />
                    ) : (
                      <EyeOff className="h-3 w-3" />
                    )}
                    {notesShown === undefined ? 'Show' : 'Hide'}
                  </Button>
                  <IconAction
                    label="Copy notes"
                    onClick={() => void actions.copy(entry.id, 'notes', 'Notes')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </IconAction>
                </div>
              </div>
            </div>
          </div>
        )}

        {entry.tags.length > 0 && (
          <div className="space-y-2">
            <h3 className={cn(SECTION_HEADING, 'flex items-center gap-1.5 px-1')}>
              <Tag className="h-2.5 w-2.5" />
              Tags
            </h3>
            <div className="flex flex-wrap items-center gap-1.5">
              {entry.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onTagClick(tag)}
                  className="h-6 cursor-pointer rounded-full bg-foreground/[0.05] px-2.5 text-[11px] font-medium text-foreground/85 ring-1 ring-inset ring-foreground/[0.08] transition-colors hover:bg-primary/12 hover:text-primary hover:ring-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="px-1 text-[11px] text-muted-foreground">
          Created {relativeDate(entry.createdAt)} · Updated {relativeDate(entry.updatedAt)}
          {entry.lastUsedAt !== null && ` · Last used ${relativeDate(entry.lastUsedAt)}`}
        </p>
      </div>
    </section>
  );
}
