import * as PopoverPrimitive from '@radix-ui/react-popover';
import { isGrammarMistake } from '@runova/core';
import type { GrammarIssue } from '@shared/grammar';
import { useState } from 'react';
import { Ban, Check, RefreshCw, SpellCheck, Spinner, X } from '@/components/icons';
import { Chip, FOOTER_HAIRLINE, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { OVERLAY_MOTION, OVERLAY_SURFACE } from '@/components/ui/overlay';
import { SimpleTooltip } from '@/components/ui/tooltip';
import type { GrammarCheckState } from '@/hooks/useGrammarCheck';
import { issueKey, issueStyle, issueTitle, replaceFieldRange, type TextField } from '@/lib/grammar';
import { persianTextProps } from '@/lib/rtl';
import { cn } from '@/lib/utils';

export interface GrammarPanelProps {
  field: TextField | null;
  value: string;
  state: GrammarCheckState;
  /** Reported as the user points at a row, so the field can highlight that issue. */
  onActiveIssueChange?: (issue: GrammarIssue | null) => void;
  className?: string;
}

/** Nudges the caret to the issue so the user can see what is being talked about. */
function reveal(field: TextField | null, issue: GrammarIssue): void {
  if (!field) return;
  field.focus();
  field.setSelectionRange(issue.offset, issue.offset + issue.length);
}

function applyFix(field: TextField | null, issue: GrammarIssue, replacement: string): void {
  if (!field) return;
  // The value can have moved on since the check; replacing then would corrupt
  // the text rather than fix it.
  if (field.value.slice(issue.offset, issue.offset + issue.length) !== issue.text) return;
  replaceFieldRange(field, issue.offset, issue.offset + issue.length, replacement);
}

/**
 * Applies one suggestion per issue, back to front so each replacement leaves the
 * offsets of the ones before it untouched.
 */
function applyAll(field: TextField | null, issues: GrammarIssue[]): void {
  if (!field) return;
  const ordered = [...issues].sort((a, b) => b.offset - a.offset);
  for (const issue of ordered) {
    const replacement = issue.replacements[0];
    if (replacement) applyFix(field, issue, replacement);
  }
}

/** A press inside the panel must not steal the caret from the field, or a fix lands elsewhere. */
function keepFieldFocus(event: React.MouseEvent): void {
  event.preventDefault();
}

/**
 * The writing review panel: every issue LanguageTool found in one field, with
 * its suggestions, in the order they appear in the text. The counter that opens
 * it doubles as the field's check status.
 */
export function GrammarPanel({
  field,
  value,
  state,
  onActiveIssueChange,
  className,
}: GrammarPanelProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!state.active) return null;

  const { issues, checking, error } = state;
  const mistakes = issues.filter(
    (issue) => isGrammarMistake(issue.kind) && issue.replacements.length > 0,
  );
  const hasText = value.trim().length > 0;
  const ordered = [...issues].sort((a, b) => a.offset - b.offset);

  const label = checking
    ? 'Checking…'
    : error
      ? 'Check failed'
      : issues.length === 0
        ? hasText
          ? 'No issues'
          : 'Writing check'
        : `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`;

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onActiveIssueChange?.(null);
      }}
    >
      <SimpleTooltip label="Writing check (grammar, spelling, style)">
        <PopoverPrimitive.Trigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onMouseDown={keepFieldFocus}
            // It floats over the field's text, so it keeps an opaque fill. The edge is a ring,
            // since a tinted border would lose to the global border colour.
            className={cn(
              'h-6 gap-1.5 bg-background/85 px-2.5 text-muted-foreground shadow-sm ring-1 ring-inset ring-foreground/10 hover:bg-background hover:text-foreground data-[state=open]:text-foreground data-[state=open]:ring-primary/40',
              error && 'text-destructive ring-destructive/40 hover:text-destructive',
              className,
            )}
          >
            {checking ? (
              <Spinner className="animate-spin" />
            ) : issues.length > 0 ? (
              <span className={cn('h-1.5 w-1.5 rounded-full', issueStyle(ordered[0].kind).dot)} />
            ) : (
              <SpellCheck />
            )}
            {label}
          </Button>
        </PopoverPrimitive.Trigger>
      </SimpleTooltip>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label="Writing check"
          className={cn(
            OVERLAY_SURFACE,
            OVERLAY_MOTION,
            'z-50 w-[22rem] overflow-hidden p-0 origin-[var(--radix-popover-content-transform-origin)]',
          )}
        >
          <div className="flex items-center justify-between gap-2 py-2 pl-3.5 pr-2.5 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <SpellCheck className="h-3.5 w-3.5 text-primary" />
              Writing check
            </div>
            <div className="flex items-center gap-1">
              {state.language ? <Chip>{state.language}</Chip> : null}
              <Chip tone="primary">{state.settings.source === 'local' ? 'Local' : 'Online'}</Chip>
            </div>
          </div>

          {error || state.truncatedAt !== null ? (
            <div className="space-y-2 px-2.5 pt-2.5">
              {error ? (
                <Notice size="sm" tone="destructive">
                  <span className="leading-relaxed">{error}</span>
                </Notice>
              ) : null}
              {state.truncatedAt !== null ? (
                <Notice size="sm">
                  <span className="leading-relaxed text-muted-foreground">
                    This text is long: only the first {state.truncatedAt.toLocaleString()}{' '}
                    characters were checked.
                  </span>
                </Notice>
              ) : null}
            </div>
          ) : null}

          {ordered.length === 0 ? (
            <div className="flex items-center gap-2 px-3.5 py-4 text-sm text-muted-foreground">
              {checking ? (
                <>
                  <Spinner className="h-3.5 w-3.5 animate-spin" /> Checking this text…
                </>
              ) : hasText ? (
                <>
                  <Check className="h-3.5 w-3.5 text-success" /> Nothing to fix here.
                </>
              ) : (
                'Write something and this will check it.'
              )}
            </div>
          ) : (
            <ul className="rail-scroll max-h-72 space-y-0.5 overflow-y-auto p-1.5">
              {ordered.map((issue) => {
                const style = issueStyle(issue.kind);
                const flaggedProps = persianTextProps(issue.text);
                return (
                  <li
                    key={issueKey(issue)}
                    onMouseEnter={() => onActiveIssueChange?.(issue)}
                    onMouseLeave={() => onActiveIssueChange?.(null)}
                    className="space-y-1.5 rounded-lg px-2 py-2 transition-colors hover:bg-foreground/[0.05]"
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', style.dot)} />
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {issueTitle(issue)}
                      </span>
                      <SimpleTooltip label="Ignore this one">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onMouseDown={keepFieldFocus}
                          onClick={() => state.dismiss(issue)}
                          aria-label="Ignore this issue"
                        >
                          <X />
                        </Button>
                      </SimpleTooltip>
                    </div>

                    <button
                      type="button"
                      onMouseDown={keepFieldFocus}
                      onClick={() => reveal(field, issue)}
                      dir={flaggedProps.dir}
                      className={cn(
                        'block max-w-full cursor-pointer truncate rounded-sm text-left text-sm underline decoration-wavy underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        style.decoration,
                        flaggedProps.className,
                      )}
                    >
                      {issue.text}
                    </button>

                    {issue.message ? (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {issue.message}
                      </p>
                    ) : null}

                    {issue.replacements.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {issue.replacements.slice(0, 4).map((replacement) => (
                          <Button
                            key={replacement}
                            type="button"
                            variant="tint"
                            size="xs"
                            onMouseDown={keepFieldFocus}
                            onClick={() => applyFix(field, issue, replacement)}
                            className="font-medium"
                          >
                            {replacement}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <p className="flex items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
                        <Ban className="h-3 w-3" /> No suggestion for this one
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div
            className={cn(FOOTER_HAIRLINE, 'flex items-center justify-between gap-2 px-2.5 py-2')}
          >
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              disabled={checking}
              onMouseDown={keepFieldFocus}
              onClick={() => void state.recheck()}
            >
              <RefreshCw className={cn('h-3 w-3', checking && 'animate-spin')} /> Check again
            </Button>
            {mistakes.length > 0 ? (
              <SimpleTooltip label="Applies the top suggestion for spelling, grammar, and punctuation. Style stays as written.">
                <Button
                  size="sm"
                  onMouseDown={keepFieldFocus}
                  onClick={() => applyAll(field, mistakes)}
                >
                  Fix {mistakes.length} {mistakes.length === 1 ? 'mistake' : 'mistakes'}
                </Button>
              </SimpleTooltip>
            ) : null}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
