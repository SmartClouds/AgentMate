import { GRAMMAR_ISSUE_KIND_LABELS, type GrammarIssueKind } from '@runova/core';
import type { GrammarIssue } from '@shared/grammar';

export type TextField = HTMLTextAreaElement | HTMLInputElement;

/** The kinds of `<input>` you type into. A checkbox, a slider or a color well is not one. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

export function isEditableTextField(node: EventTarget | null): node is TextField {
  if (!(node instanceof HTMLTextAreaElement) && !(node instanceof HTMLInputElement)) return false;
  if (node.readOnly || node.disabled) return false;
  if (node instanceof HTMLInputElement && !TEXT_INPUT_TYPES.has(node.type)) return false;
  // xterm keeps a hidden textarea over the cursor to receive keystrokes. It is
  // editable as far as the DOM is concerned, but the terminal owns right-click
  // (copy/paste), and there is no document there to check.
  if (node.closest('.xterm') !== null) return false;
  // Monaco does the same, and draws its own right-click menu for the code. Only
  // that textarea is left out: the find box beside it is an ordinary box.
  return !(node.classList.contains('inputarea') && node.closest('.monaco-editor') !== null);
}

/**
 * Replaces a range in a text field the way typing would, so React's controlled
 * value, the browser's undo stack, and the caret all end up correct.
 */
export function replaceFieldRange(
  field: TextField,
  start: number,
  end: number,
  text: string,
): void {
  field.focus();
  field.setSelectionRange(start, end);
  // execCommand keeps the browser's own undo stack and fires the input event a
  // controlled React text box listens for. Assigning `field.value` skips both,
  // so it is only the fallback.
  if (!document.execCommand('insertText', false, text)) {
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setValue = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setValue?.call(field, field.value.slice(0, start) + text + field.value.slice(end));
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const caret = start + text.length;
  field.setSelectionRange(caret, caret);
}

/** Stable enough to remember a dismissal across re-checks of unchanged text. */
export function issueKey(issue: GrammarIssue): string {
  return `${issue.ruleId}@${issue.offset}:${issue.text}`;
}

/**
 * Drops issues whose offsets no longer point at the text they were found in.
 * Checks are asynchronous, so a keystroke can land while one is in flight; this
 * is what keeps an underline (or a fix) from being applied to shifted text.
 * A fresh check follows the edit, so the dropped ones come back if they still hold.
 */
export function alignIssues(issues: GrammarIssue[], value: string): GrammarIssue[] {
  return issues.filter(
    (issue) => value.slice(issue.offset, issue.offset + issue.length) === issue.text,
  );
}

/** The issue under the caret, preferring the shortest when several overlap. */
export function issueAtOffset(issues: GrammarIssue[], offset: number): GrammarIssue | null {
  const hits = issues.filter(
    (issue) => offset >= issue.offset && offset <= issue.offset + issue.length,
  );
  if (hits.length === 0) return null;
  return hits.reduce((best, issue) => (issue.length < best.length ? issue : best));
}

/** Next issue after the caret, wrapping back to the first one. */
export function nextIssueFrom(issues: GrammarIssue[], offset: number): GrammarIssue | null {
  if (issues.length === 0) return null;
  const sorted = [...issues].sort((a, b) => a.offset - b.offset);
  return sorted.find((issue) => issue.offset > offset) ?? sorted[0];
}

/** A whole-value check past this is slow enough to be worth narrowing to one paragraph. */
const ON_DEMAND_SCOPE_LIMIT = 4000;

/**
 * What a right-click should check. A selection is taken as the user saying
 * exactly that much; otherwise it is the whole field, narrowed to the paragraph
 * around the caret once the field is long enough for a full check to drag.
 */
export function checkScopeAt(
  value: string,
  caret: number,
  selection: { start: number; end: number } | null,
): { text: string; offset: number } {
  if (selection && selection.end > selection.start) {
    return { text: value.slice(selection.start, selection.end), offset: selection.start };
  }
  if (value.length <= ON_DEMAND_SCOPE_LIMIT) return { text: value, offset: 0 };

  const start = value.lastIndexOf('\n\n', Math.max(0, caret - 1));
  const end = value.indexOf('\n\n', caret);
  const from = start === -1 ? 0 : start + 2;
  const to = end === -1 ? value.length : end;
  return { text: value.slice(from, to), offset: from };
}

/** Shifts issues found in a slice back onto the whole field's coordinates. */
export function shiftIssues(issues: GrammarIssue[], offset: number): GrammarIssue[] {
  if (offset === 0) return issues;
  return issues.map((issue) => ({ ...issue, offset: issue.offset + offset }));
}

interface IssueStyle {
  label: string;
  /** Underline color for the overlay drawn over the text. */
  decoration: string;
  /** Matching dot color for lists and counters. */
  dot: string;
  text: string;
}

const ISSUE_STYLES: Record<GrammarIssueKind, IssueStyle> = {
  spelling: {
    label: GRAMMAR_ISSUE_KIND_LABELS.spelling,
    decoration: 'decoration-red-500',
    dot: 'bg-red-500',
    text: 'text-red-500',
  },
  grammar: {
    label: GRAMMAR_ISSUE_KIND_LABELS.grammar,
    decoration: 'decoration-blue-500',
    dot: 'bg-blue-500',
    text: 'text-blue-500',
  },
  punctuation: {
    label: GRAMMAR_ISSUE_KIND_LABELS.punctuation,
    decoration: 'decoration-amber-500',
    dot: 'bg-amber-500',
    text: 'text-amber-500',
  },
  typography: {
    label: GRAMMAR_ISSUE_KIND_LABELS.typography,
    decoration: 'decoration-violet-400',
    dot: 'bg-violet-400',
    text: 'text-violet-400',
  },
  style: {
    label: GRAMMAR_ISSUE_KIND_LABELS.style,
    decoration: 'decoration-emerald-500',
    dot: 'bg-emerald-500',
    text: 'text-emerald-500',
  },
  other: {
    label: GRAMMAR_ISSUE_KIND_LABELS.other,
    decoration: 'decoration-sky-500',
    dot: 'bg-sky-500',
    text: 'text-sky-500',
  },
};

export function issueStyle(kind: GrammarIssueKind): IssueStyle {
  return ISSUE_STYLES[kind] ?? ISSUE_STYLES.other;
}

/** LanguageTool's own short label when it has one, otherwise the category. */
export function issueTitle(issue: GrammarIssue): string {
  return issue.shortMessage || issue.categoryName || issueStyle(issue.kind).label;
}
