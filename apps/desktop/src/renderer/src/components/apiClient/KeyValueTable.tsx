import type { KeyValueRow } from '@runova/core';
import { useState } from 'react';
import { Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The editable key/value grid behind Params, Headers and form bodies. There is always one blank
 * row at the end; typing in it turns it into a real row and a new blank one appears, so adding a
 * row never needs a button.
 */

interface KeyValueTableProps {
  /** Names the table for screen readers and prefixes each field's label. */
  label: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Hides the bulk edit switch, for tables where it makes no sense. */
  allowBulkEdit?: boolean;
}

function blankRow(id: string): KeyValueRow {
  return { id, key: '', value: '', enabled: true, description: '' };
}

/** Postman's bulk format: one `key:value` per line, `//` in front of a disabled row. */
export function rowsToBulk(rows: readonly KeyValueRow[]): string {
  return rows.map((r) => `${r.enabled ? '' : '//'}${r.key}:${r.value}`).join('\n');
}

export function bulkToRows(text: string, previous: readonly KeyValueRow[]): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const enabled = !line.trimStart().startsWith('//');
    const body = enabled ? line : line.trimStart().slice(2);
    const colon = body.indexOf(':');
    const key = (colon < 0 ? body : body.slice(0, colon)).trim();
    const value = colon < 0 ? '' : body.slice(colon + 1).trim();
    const kept = previous.find((r) => r.key === key && !rows.some((x) => x.id === r.id));
    rows.push({
      id: kept?.id ?? crypto.randomUUID(),
      key,
      value,
      enabled,
      description: kept?.description ?? '',
    });
  }
  return rows;
}

export function KeyValueTable({
  label,
  rows,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  allowBulkEdit = true,
}: KeyValueTableProps): React.JSX.Element {
  const [bulk, setBulk] = useState<string | null>(null);
  // The blank row's id is handed to the row it turns into, so React keeps the same inputs and
  // the caret stays where the user is typing.
  const [blankId, setBlankId] = useState(() => crypto.randomUUID());

  function update(id: string, patch: Partial<KeyValueRow>): void {
    if (id === blankId) {
      onChange([...rows, { ...blankRow(blankId), ...patch }]);
      setBlankId(crypto.randomUUID());
      return;
    }
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  const toggle = allowBulkEdit ? (
    <div className="flex justify-end">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          if (bulk === null) {
            setBulk(rowsToBulk(rows));
          } else {
            onChange(bulkToRows(bulk, rows));
            setBulk(null);
          }
        }}
        className="text-muted-foreground hover:text-foreground"
      >
        {bulk === null ? 'Bulk edit' : 'Key-value edit'}
      </Button>
    </div>
  ) : null;

  if (bulk !== null) {
    return (
      <div className="flex flex-col gap-1.5">
        {toggle}
        <Textarea
          aria-label={`${label} bulk edit`}
          value={bulk}
          onChange={(event) => setBulk(event.target.value)}
          spellCheck={false}
          placeholder={'key:value\n//disabled:value'}
          className="min-h-[160px] resize-y font-mono text-xs leading-5"
        />
      </div>
    );
  }

  const shown = [...rows, blankRow(blankId)];
  const cell =
    'h-8 w-full min-w-0 bg-transparent px-2.5 font-mono text-xs outline-none placeholder:text-muted-foreground/60 focus-visible:bg-accent/40';

  return (
    <div className="flex flex-col gap-1.5">
      {toggle}
      <div
        role="table"
        aria-label={label}
        className="overflow-hidden rounded-lg border border-border"
      >
        <div
          role="row"
          className="grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1.4fr)_2rem] border-b border-border bg-muted/40 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          <span role="columnheader" className="sr-only">
            Include
          </span>
          <span aria-hidden />
          <span role="columnheader" className="px-2.5 py-1.5">
            {keyPlaceholder}
          </span>
          <span role="columnheader" className="border-l border-border px-2.5 py-1.5">
            {valuePlaceholder}
          </span>
          <span aria-hidden />
        </div>
        {shown.map((r) => {
          const isBlank = r.id === blankId;
          return (
            <div
              key={r.id}
              role="row"
              data-row
              data-disabled={!r.enabled}
              className={cn(
                'group grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1.4fr)_2rem] items-center border-b border-border last:border-b-0 transition-colors hover:bg-accent/30',
                !r.enabled && 'text-muted-foreground',
              )}
            >
              <span className="flex justify-center">
                {!isBlank && (
                  <Checkbox
                    checked={r.enabled}
                    onCheckedChange={(checked) => update(r.id, { enabled: checked === true })}
                    aria-label={`Include ${r.key || 'row'}`}
                  />
                )}
              </span>
              <input
                aria-label={`${label} key`}
                value={r.key}
                placeholder={isBlank ? keyPlaceholder : ''}
                onChange={(event) => update(r.id, { key: event.target.value })}
                spellCheck={false}
                className={cn(cell, !r.enabled && 'line-through decoration-muted-foreground/50')}
              />
              <input
                aria-label={`${label} value`}
                value={r.value}
                placeholder={isBlank ? valuePlaceholder : ''}
                onChange={(event) => update(r.id, { value: event.target.value })}
                spellCheck={false}
                className={cn(cell, 'border-l border-border')}
              />
              <span className="flex justify-center">
                {!isBlank && (
                  <SimpleTooltip label="Remove">
                    <button
                      type="button"
                      aria-label={`Remove ${r.key || 'row'}`}
                      onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </SimpleTooltip>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
