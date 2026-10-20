import { formatBytes } from '@shared/remoteProtocol';
import type { SftpChmodScope, SftpRemoteEntry } from '@shared/sftpTypes';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { filesProblem } from '@/components/deploy/files/messages';
import { ChevronRight, Copy, Spinner } from '@/components/icons';
import { Problem, SECTION_HEADING, SEGMENT_TRACK, segmentClass } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SimpleTooltip } from '@/components/ui/tooltip';
import {
  type BitState,
  formatMode,
  formatOctal,
  type MixedModeGrid,
  MODE_BITS,
  MODE_CLASSES,
  MODE_PERMS,
  MODE_SPECIALS,
  type ModeClass,
  type ModeKind,
  type ModePerm,
  type ModeSpecial,
  mergeModes,
  modeToGrid,
  parseOctal,
  SPECIAL_BITS,
} from '@/lib/sftp/mode';
import { cn } from '@/lib/utils';
import type { PropertiesDialogProps } from './contracts';

/**
 * Details and permissions of the selected remote entries (E25). A Read / Write / Execute grid for
 * owner, group and others, the special bits under a fold, and an octal field: change either and
 * the other follows. With several entries selected, a bit they disagree on shows as mixed and is
 * left as each entry has it unless it is clicked, so Apply sends one chmod per mode that comes
 * out. A real folder (not a link to one) also offers "Also apply inside".
 */

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

const CLASS_LABEL: Record<ModeClass, string> = { owner: 'Owner', group: 'Group', others: 'Others' };
const PERM_LABEL: Record<ModePerm, string> = { read: 'Read', write: 'Write', execute: 'Execute' };
const SPECIAL_LABEL: Record<ModeSpecial, { label: string; hint: string }> = {
  setuid: {
    label: 'Set user ID (setuid)',
    hint: 'A program runs as the file owner, whoever starts it.',
  },
  setgid: {
    label: 'Set group ID (setgid)',
    hint: 'A program runs as the group. On a folder, new files take the folder group.',
  },
  sticky: {
    label: 'Sticky',
    hint: 'On a folder, only the owner of a file can rename or delete it.',
  },
};

const SCOPES: { value: Exclude<SftpChmodScope, 'none'>; label: string }[] = [
  { value: 'all', label: 'Folders and files' },
  { value: 'files', label: 'Files only' },
  { value: 'dirs', label: 'Folders only' },
];

/** The bits set to on, and the bits left mixed. */
function masks(grid: MixedModeGrid): { on: number; mixed: number } {
  let on = 0;
  let mixed = 0;
  const add = (state: BitState, bit: number): void => {
    if (state === 'on') on |= bit;
    else if (state === 'mixed') mixed |= bit;
  };
  for (const cls of MODE_CLASSES) {
    for (const perm of MODE_PERMS) add(grid[cls][perm], MODE_BITS[cls][perm]);
  }
  for (const special of MODE_SPECIALS) add(grid.special[special], SPECIAL_BITS[special]);
  return { on, mixed };
}

/** What the octal field shows for a grid: nothing while a bit is mixed. */
function octalFor(grid: MixedModeGrid): string {
  const { on, mixed } = masks(grid);
  return mixed === 0 ? formatOctal(on) : '';
}

/** A plain mode as a grid with nothing mixed. */
function definite(mode: number): MixedModeGrid {
  const grid = modeToGrid(mode);
  const state = (on: boolean): BitState => (on ? 'on' : 'off');
  const row = (cls: ModeClass): Record<ModePerm, BitState> => ({
    read: state(grid[cls].read),
    write: state(grid[cls].write),
    execute: state(grid[cls].execute),
  });
  return {
    owner: row('owner'),
    group: row('group'),
    others: row('others'),
    special: {
      setuid: state(grid.special.setuid),
      setgid: state(grid.special.setgid),
      sticky: state(grid.special.sticky),
    },
  };
}

function typeLabel(entry: SftpRemoteEntry): string {
  if (entry.isSymlink) {
    if (entry.kind === 'link') return 'Broken link';
    return entry.isDirectory ? 'Link to a folder' : 'Link to a file';
  }
  if (entry.kind === 'dir') return 'Folder';
  if (entry.kind === 'other') return 'Special file';
  return 'File';
}

function modeKind(entries: SftpRemoteEntry[]): ModeKind {
  if (entries.length === 1) {
    const only = entries[0]!;
    if (only.isSymlink) return 'link';
    return only.kind === 'dir' ? 'dir' : only.kind === 'other' ? 'other' : 'file';
  }
  return entries.every((e) => e.kind === 'dir' && !e.isSymlink) ? 'dir' : 'file';
}

/** "3 files, 1 folder". */
function countsText(entries: SftpRemoteEntry[]): string {
  const folders = entries.filter((e) => e.isDirectory).length;
  const files = entries.length - folders;
  const part = (n: number, word: string): string | null =>
    n > 0 ? `${n} ${n === 1 ? word : `${word}s`}` : null;
  return [part(files, 'file'), part(folders, 'folder')].filter(Boolean).join(', ');
}

/** The one value every entry shares, or null when they differ. */
function shared(values: (string | null)[]): string | null | undefined {
  const first = values[0];
  return values.every((v) => v === first) ? first : undefined;
}

export function PropertiesDialog({
  open,
  entries,
  onOpenChange,
  onApply,
}: PropertiesDialogProps): React.JSX.Element {
  return (
    <Dialog open={open && entries.length > 0} onOpenChange={onOpenChange}>
      {open && entries.length > 0 && (
        <PropertiesBody
          // Each opening starts again from what the entries have now.
          key={entries.map((e) => `${e.path}:${e.mode}`).join('\n')}
          entries={entries}
          onOpenChange={onOpenChange}
          onApply={onApply}
        />
      )}
    </Dialog>
  );
}

function PropertiesBody({
  entries,
  onOpenChange,
  onApply,
}: Omit<PropertiesDialogProps, 'open'>): React.JSX.Element {
  const [initial] = useState(() => masks(mergeModes(entries.map((e) => e.mode))));
  const [grid, setGrid] = useState<MixedModeGrid>(() => mergeModes(entries.map((e) => e.mode)));
  const [octalText, setOctalText] = useState(() => octalFor(grid));
  const [specialOpen, setSpecialOpen] = useState(false);
  const [inside, setInside] = useState(false);
  const [scope, setScope] = useState<Exclude<SftpChmodScope, 'none'>>('all');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const octalId = useId();
  const octalHelpId = useId();
  const insideId = useId();
  const specialId = useId();

  const single = entries.length === 1 ? entries[0]! : null;
  const offersInside = entries.some((e) => e.isDirectory && !e.isSymlink);
  const { on, mixed } = masks(grid);
  const valid = octalText.trim() === '' ? mixed !== 0 : parseOctal(octalText) !== null;
  // The same bits again change nothing, unless they now reach inside a folder.
  const changed = on !== initial.on || mixed !== initial.mixed || (offersInside && inside);
  const anySpecial = MODE_SPECIALS.some((s) => grid.special[s] !== 'off');
  const showSpecial = specialOpen || anySpecial;
  const owner = shared(entries.map((e) => e.owner));
  const group = shared(entries.map((e) => e.group));

  function update(next: MixedModeGrid): void {
    setGrid(next);
    setOctalText(octalFor(next));
  }

  function toggle(cls: ModeClass | 'special', key: ModePerm | ModeSpecial): void {
    const row = cls === 'special' ? grid.special : grid[cls];
    const now = (row as Record<string, BitState>)[key];
    const nextState: BitState = now === 'on' ? 'off' : 'on';
    update({ ...grid, [cls]: { ...row, [key]: nextState } } as MixedModeGrid);
  }

  function typeOctal(text: string): void {
    setOctalText(text);
    const mode = parseOctal(text);
    if (mode !== null) setGrid(definite(mode));
  }

  async function apply(): Promise<void> {
    if (!valid || !changed || applying) return;
    setApplying(true);
    setError(null);
    const recursive: SftpChmodScope = offersInside && inside ? scope : 'none';
    // A mixed bit stays as each entry has it, so entries that come out alike share one chmod.
    const byMode = new Map<number, string[]>();
    for (const entry of entries) {
      const mode = (entry.mode & mixed) | on;
      byMode.set(mode, [...(byMode.get(mode) ?? []), entry.path]);
    }
    try {
      await Promise.all([...byMode].map(([mode, paths]) => onApply({ paths, mode, recursive })));
      onOpenChange(false);
    } catch (failure) {
      setError(failure);
    } finally {
      setApplying(false);
    }
  }

  async function copyPath(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
      toast.success('Path copied');
    } catch {
      toast.error('Could not copy the path');
    }
  }

  const preview = mixed === 0 ? formatMode(on, modeKind(entries)) : null;

  return (
    <DialogContent
      className="max-w-lg"
      onOpenAutoFocus={(event) => {
        // The first focusable is the path's copy button, whose tooltip would pop up and eat the
        // first Escape. The octal field is what people come here to change.
        const field = document.getElementById(octalId);
        if (field instanceof HTMLInputElement) {
          event.preventDefault();
          field.focus();
          field.select();
        }
      }}
    >
      <DialogHeader className="pr-8">
        <DialogTitle className="truncate leading-normal">
          {single ? single.name : `${entries.length} items`}
        </DialogTitle>
        <DialogDescription>
          {single
            ? 'Details and permissions on the server.'
            : 'Permissions for everything selected.'}
        </DialogDescription>
      </DialogHeader>

      <div className="rail-scroll -mx-6 space-y-5 overflow-y-auto px-6">
        <section aria-label="Details" className="space-y-2">
          <h3 className={SECTION_HEADING}>Details</h3>
          <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
            {single ? (
              <>
                <dt className="text-muted-foreground">Path</dt>
                <dd className="flex min-w-0 items-center gap-1">
                  <span className="min-w-0 truncate font-mono text-foreground/90">
                    {single.path}
                  </span>
                  <SimpleTooltip label="Copy path">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Copy path"
                      onClick={() => void copyPath(single.path)}
                    >
                      <Copy />
                    </Button>
                  </SimpleTooltip>
                </dd>
                <dt className="text-muted-foreground">Type</dt>
                <dd>{typeLabel(single)}</dd>
                {!single.isDirectory && (
                  <>
                    <dt className="text-muted-foreground">Size</dt>
                    <dd className="tabular-nums">{formatBytes(single.size)}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Modified</dt>
                <dd className="tabular-nums">{DATE.format(single.mtimeMs)}</dd>
              </>
            ) : (
              <>
                <dt className="text-muted-foreground">Selected</dt>
                <dd>{countsText(entries)}</dd>
                <dt className="text-muted-foreground">Size of files</dt>
                <dd className="tabular-nums">
                  {formatBytes(
                    entries.filter((e) => !e.isDirectory).reduce((sum, e) => sum + e.size, 0),
                  )}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Owner</dt>
            <dd className="truncate">
              {owner === undefined ? 'Mixed owners' : (owner ?? 'Not known')}
            </dd>
            <dt className="text-muted-foreground">Group</dt>
            <dd className="truncate">
              {group === undefined ? 'Mixed groups' : (group ?? 'Not known')}
            </dd>
          </dl>
        </section>

        <section aria-label="Permissions" className="space-y-3">
          <h3 className={SECTION_HEADING}>Permissions</h3>
          <table className="w-full max-w-sm text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="w-20 pb-1.5 text-left font-medium">
                  <span className="sr-only">Who</span>
                </th>
                {MODE_PERMS.map((perm) => (
                  <th key={perm} scope="col" className="pb-1.5 text-center font-medium">
                    {PERM_LABEL[perm]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MODE_CLASSES.map((cls) => (
                <tr key={cls}>
                  <th scope="row" className="py-1 text-left font-medium">
                    {CLASS_LABEL[cls]}
                  </th>
                  {MODE_PERMS.map((perm) => (
                    <td key={perm} className="py-1">
                      <div className="flex justify-center">
                        <BitBox
                          label={`${CLASS_LABEL[cls]} ${perm}`}
                          state={grid[cls][perm]}
                          disabled={applying}
                          onToggle={() => toggle(cls, perm)}
                        />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="space-y-2">
            <button
              type="button"
              aria-expanded={showSpecial}
              aria-controls={specialId}
              disabled={anySpecial}
              onClick={() => setSpecialOpen(!specialOpen)}
              className="flex cursor-pointer items-center gap-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:text-muted-foreground"
            >
              <ChevronRight
                className={cn(
                  'h-3 w-3 transition-transform duration-150',
                  showSpecial && 'rotate-90',
                )}
              />
              Special bits
            </button>
            {showSpecial && (
              <div id={specialId} className="space-y-1.5 pl-4">
                {MODE_SPECIALS.map((special) => (
                  <div key={special} className="flex items-center gap-2.5 text-xs">
                    <BitBox
                      label={SPECIAL_LABEL[special].label}
                      state={grid.special[special]}
                      disabled={applying}
                      onToggle={() => toggle('special', special)}
                    />
                    <SimpleTooltip label={SPECIAL_LABEL[special].hint} align="start">
                      <span className="cursor-default">{SPECIAL_LABEL[special].label}</span>
                    </SimpleTooltip>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <label htmlFor={octalId} className="text-xs font-medium">
                Octal
              </label>
              <Input
                id={octalId}
                value={octalText}
                placeholder={mixed !== 0 ? 'Mixed' : '644'}
                onChange={(e) => typeOctal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void apply();
                }}
                inputMode="numeric"
                maxLength={4}
                spellCheck={false}
                autoComplete="off"
                disabled={applying}
                aria-invalid={!valid}
                aria-describedby={!valid ? octalHelpId : undefined}
                className="h-8 w-20 font-mono tabular-nums"
              />
              {preview && (
                <span className="font-mono text-xs text-muted-foreground">{preview}</span>
              )}
            </div>
            {!valid && (
              <p id={octalHelpId} className="text-xs text-destructive">
                Use 3 or 4 digits from 0 to 7, like 755 or 0644.
              </p>
            )}
            {mixed !== 0 && valid && (
              <p className="text-xs text-muted-foreground">
                Mixed boxes stay as each item has them. Click one to set it for all.
              </p>
            )}
          </div>
        </section>

        {offersInside && (
          <section aria-label="Folders" className="space-y-2">
            <div className="flex items-center gap-2.5">
              <Checkbox
                id={insideId}
                checked={inside}
                disabled={applying}
                onCheckedChange={(v) => setInside(v === true)}
              />
              <label htmlFor={insideId} className="cursor-pointer select-none text-sm">
                Also apply inside
              </label>
            </div>
            {inside && (
              <div className="space-y-1.5 pl-7">
                <div role="radiogroup" aria-label="Apply inside to" className={SEGMENT_TRACK}>
                  {SCOPES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={scope === option.value}
                      disabled={applying}
                      onClick={() => setScope(option.value)}
                      className={segmentClass(scope === option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  The folder itself changes too. Links inside are left alone.
                </p>
              </div>
            )}
          </section>
        )}

        {error !== null && <Problem message={filesProblem(error)} />}
      </div>

      <DialogFooter>
        <Button variant="soft" disabled={applying} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button disabled={!valid || !changed || applying} onClick={() => void apply()}>
          {applying && <Spinner className="motion-safe:animate-spin" />}
          Apply
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function BitBox({
  label,
  state,
  disabled,
  onToggle,
}: {
  label: string;
  state: BitState;
  disabled: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <Checkbox
      aria-label={label}
      checked={state === 'mixed' ? 'indeterminate' : state === 'on'}
      disabled={disabled}
      onCheckedChange={onToggle}
      // Mixed reads as a dash on a lighter fill, not as the tick of a set bit.
      className="data-[state=indeterminate]:bg-primary/35 data-[state=indeterminate]:after:h-[2px] data-[state=indeterminate]:after:w-2 data-[state=indeterminate]:after:rounded-full data-[state=indeterminate]:after:bg-current data-[state=indeterminate]:after:content-[''] data-[state=indeterminate]:[&_svg]:hidden"
    />
  );
}
