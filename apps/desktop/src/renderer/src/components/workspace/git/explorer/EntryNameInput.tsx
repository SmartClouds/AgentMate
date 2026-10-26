import { splitExtension, validateEntryName } from '@runova/core';
import { useEffect, useRef, useState } from 'react';
import { cachedListing } from './actions';

const CASE_INSENSITIVE = (): boolean =>
  window.runova.platform === 'win32' || window.runova.platform === 'darwin';

/**
 * The inline name box for renaming a row or naming a new one. Enter commits, Escape cancels,
 * and clicking away commits a valid name or drops an empty or invalid one, like VS Code.
 */
export function EntryNameInput({
  projectId,
  parent,
  initial = '',
  isDirectory,
  allowNested,
  onCommit,
  onCancel,
}: {
  projectId: string;
  /** The folder the name goes in, to catch a clash before asking the main process. */
  parent: string;
  initial?: string;
  isDirectory: boolean;
  allowNested: boolean;
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const settledRef = useRef(false);
  const mountedAtRef = useRef(Date.now());

  // Rename selects the name without its extension, so typing replaces just that part.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const frame = requestAnimationFrame(() => {
      input.focus();
      const end = isDirectory ? initial.length : splitExtension(initial).base.length;
      input.setSelectionRange(0, end);
    });
    return () => cancelAnimationFrame(frame);
  }, [initial, isDirectory]);

  const error = ((): string | null => {
    if (!value || value === initial) return null;
    const problem = validateEntryName(value, window.runova.platform, { allowNested });
    if (problem) return problem;
    const first = value.split(/[\\/]/)[0] ?? value;
    const fold = (name: string): string => (CASE_INSENSITIVE() ? name.toLowerCase() : name);
    const renamingCaseOnly = initial !== '' && fold(first) === fold(initial);
    const nestedIntoFolder = /[\\/]/.test(value);
    const clash = cachedListing(projectId, parent).find(
      (entry) => fold(entry.name) === fold(first),
    );
    if (clash && !renamingCaseOnly && !(nestedIntoFolder && clash.isDirectory)) {
      return `A file or folder named "${first}" already exists at this location. Choose a different name.`;
    }
    return null;
  })();

  async function commit(): Promise<void> {
    if (settledRef.current || busy) return;
    if (!value.trim() || value === initial || error) {
      settledRef.current = true;
      onCancel();
      return;
    }
    setBusy(true);
    const ok = await onCommit(value);
    setBusy(false);
    if (ok) {
      settledRef.current = true;
    } else {
      inputRef.current?.focus();
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        value={value}
        disabled={busy}
        spellCheck={false}
        aria-label={initial ? `New name for ${initial}` : isDirectory ? 'Folder name' : 'File name'}
        aria-invalid={error !== null}
        onChange={(event) => setValue(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        // The tree around this box opens the file menu on a right-click, by cancelling the
        // event. A cancelled right-click never reaches the main process, which is where the
        // field menu (Cut, Copy, Paste, Select all) comes from, so it has to stop here.
        onContextMenu={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            if (!error) void commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            settledRef.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          // A closing context menu hands focus back for a moment; take it again.
          if (Date.now() - mountedAtRef.current < 250) {
            requestAnimationFrame(() => inputRef.current?.focus());
            return;
          }
          void commit();
        }}
        // The shared field surface draws the edge, focus and the red invalid state from
        // aria-invalid, since a tinted border utility would lose to the global border colour.
        className="field-surface h-5 w-full min-w-0 rounded-md px-1.5 text-[12px] text-foreground outline-none"
      />
      {error ? (
        <div
          role="alert"
          className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg bg-popover px-2 py-1.5 text-[11px] leading-snug text-foreground shadow-lg ring-1 ring-inset ring-destructive/50"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
