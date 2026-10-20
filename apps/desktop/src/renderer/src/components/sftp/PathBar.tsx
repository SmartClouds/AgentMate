import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, HardDrive, Server } from '@/components/icons';
import { breadcrumbs } from '@/lib/sftp/paths';
import { cn } from '@/lib/utils';
import type { GoToResult } from '@/stores/sftpStore';

export interface PathBarProps {
  side: 'local' | 'remote';
  /** The folder shown; null before the first listing. */
  path: string | null;
  /** Text mode, owned by the pane so Ctrl+L in the list can turn it on. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** A breadcrumb was clicked. */
  onNavigate: (path: string) => void;
  /**
   * A typed path. `ok` closes the field; `failed` shows the problem under it; `superseded`
   * (another navigation won the race) leaves it open with the typed text and no error.
   */
  onSubmit: (text: string) => Promise<GoToResult>;
  disabled?: boolean;
}

/**
 * Where a pane is: breadcrumb buttons, or a text field after a click on the empty space or
 * Ctrl+L. Enter goes there, Escape puts the path back. A path that fails keeps the field open
 * with the reason under it, and the pane stays where it was.
 */
export function PathBar({
  side,
  path,
  editing,
  onEditingChange,
  onNavigate,
  onSubmit,
  disabled = false,
}: PathBarProps): React.JSX.Element {
  const [text, setText] = useState(path ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const crumbsRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const Icon = side === 'remote' ? Server : HardDrive;
  const label = side === 'remote' ? 'Folder on the server' : 'Folder on this computer';

  // Opening the field starts from where the pane is; the pane moving while it is open (another
  // navigation won) leaves the typed text alone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only opening the field resets it.
  useEffect(() => {
    if (!editing) return;
    setText(path ?? '');
    setProblem(null);
    // Selecting the whole path lets the user type a new one straight away.
    requestAnimationFrame(() => inputRef.current?.select());
  }, [editing]);

  // A deep folder keeps its last crumbs in view; the root end scrolls away first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new path is what moves the crumbs.
  useLayoutEffect(() => {
    const box = crumbsRef.current;
    if (box && !editing) box.scrollLeft = box.scrollWidth;
  }, [path, editing]);

  async function submit(): Promise<void> {
    if (busy) return;
    if (text.trim() === '' || text === path) {
      onEditingChange(false);
      return;
    }
    setBusy(true);
    const result = await onSubmit(text);
    setBusy(false);
    if (result.status === 'ok') {
      onEditingChange(false);
      return;
    }
    if (result.status === 'failed') setProblem(result.problem);
    // The field was disabled while it waited, which dropped the focus; give it back.
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  if (editing) {
    return (
      <div className="relative min-w-0 flex-1">
        <div className="search-pill flex h-8 min-w-0 items-center gap-2 rounded-full px-3">
          <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
          <input
            ref={inputRef}
            aria-label={label}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${side}-path-problem` : undefined}
            value={text}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => {
              setText(event.target.value);
              setProblem(null);
            }}
            onBlur={() => {
              if (!busy) onEditingChange(false);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onEditingChange(false);
              }
            }}
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground"
            placeholder={side === 'remote' ? '/var/www, ~ or a folder name' : 'A folder path'}
          />
        </div>
        {problem ? (
          <p
            id={`${side}-path-problem`}
            role="alert"
            className="absolute left-3 right-3 top-full z-10 mt-1 truncate rounded-md bg-popover/95 px-2 py-1 text-[11px] text-destructive shadow-sm"
          >
            {problem}
          </p>
        ) : null}
      </div>
    );
  }

  const crumbs = path ? breadcrumbs(path) : [];
  return (
    <div
      className={cn(
        'search-pill flex h-8 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-full pl-3 pr-1.5',
        disabled && 'pointer-events-none opacity-60',
      )}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest('button')) onEditingChange(true);
      }}
    >
      <Icon className="pointer-events-none h-3.5 w-3.5 shrink-0 text-primary" />
      <nav aria-label={label} className="min-w-0 flex-1">
        <div
          ref={crumbsRef}
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
                {index > 0 ? (
                  <ChevronRight aria-hidden className="h-2 w-2 shrink-0 text-muted-foreground/60" />
                ) : null}
                <button
                  type="button"
                  aria-current={last ? 'location' : undefined}
                  onClick={() => onNavigate(crumb.path)}
                  className={cn(
                    'max-w-[14rem] shrink-0 cursor-pointer truncate rounded-md px-1 py-0.5 font-mono text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    last
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
                  )}
                >
                  {crumb.label}
                </button>
              </span>
            );
          })}
          {/* Room to click past the last crumb, which turns the bar into a field. */}
          <span aria-hidden data-testid={`${side}-path-space`} className="h-6 min-w-6 flex-1" />
        </div>
      </nav>
    </div>
  );
}
