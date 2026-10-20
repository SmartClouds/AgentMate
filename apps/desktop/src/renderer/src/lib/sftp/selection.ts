/**
 * The selection of one pane in the SFTP file manager (E25), as plain data so the store can keep
 * it and a refresh can carry it over. Rows are named by their entry name, which is unique in a
 * folder; `names` is always the pane's visible order.
 */

export interface Selection {
  /** Selected names, in the order the list shows them. */
  selected: string[];
  /** The row the keyboard is on (`aria-activedescendant`). */
  focus: string | null;
  /** Where a Shift range starts. */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { selected: [], focus: null, anchor: null };

export interface ClickModifiers {
  /** Ctrl or Cmd: add or take away one row. */
  toggle?: boolean;
  /** Shift: everything from the anchor to here. */
  range?: boolean;
}

function inOrder(names: readonly string[], picked: ReadonlySet<string>): string[] {
  return names.filter((name) => picked.has(name));
}

function rangeOf(names: readonly string[], from: string, to: string): string[] {
  const start = names.indexOf(from);
  const end = names.indexOf(to);
  if (start < 0 || end < 0) return [to];
  return names.slice(Math.min(start, end), Math.max(start, end) + 1);
}

export function clickSelect(
  selection: Selection,
  names: readonly string[],
  name: string,
  modifiers: ClickModifiers,
): Selection {
  if (modifiers.range && selection.anchor && names.includes(selection.anchor)) {
    return {
      selected: rangeOf(names, selection.anchor, name),
      focus: name,
      anchor: selection.anchor,
    };
  }
  if (modifiers.toggle) {
    const picked = new Set(selection.selected);
    if (picked.has(name)) picked.delete(name);
    else picked.add(name);
    return { selected: inOrder(names, picked), focus: name, anchor: name };
  }
  return { selected: [name], focus: name, anchor: name };
}

/**
 * The arrows (`1` and `-1`), Home and End. Without Shift the row moved to becomes the only one
 * selected; with Shift the selection runs from the anchor to it.
 */
export function moveFocus(
  selection: Selection,
  names: readonly string[],
  step: 1 | -1 | 'home' | 'end',
  options: { extend?: boolean },
): Selection {
  if (names.length === 0) return EMPTY_SELECTION;
  const current = selection.focus ? names.indexOf(selection.focus) : -1;
  let index: number;
  if (step === 'home') index = 0;
  else if (step === 'end') index = names.length - 1;
  else if (current < 0) index = step === 1 ? 0 : names.length - 1;
  else index = Math.min(names.length - 1, Math.max(0, current + step));
  const target = names[index] as string;
  if (options.extend) {
    const anchor = selection.anchor && names.includes(selection.anchor) ? selection.anchor : target;
    return { selected: rangeOf(names, anchor, target), focus: target, anchor };
  }
  return { selected: [target], focus: target, anchor: target };
}

/** Ctrl+A. The focus stays where it was, or goes to the first row. */
export function selectAll(selection: Selection, names: readonly string[]): Selection {
  if (names.length === 0) return EMPTY_SELECTION;
  const focus = selection.focus && names.includes(selection.focus) ? selection.focus : names[0];
  return { selected: [...names], focus: focus ?? null, anchor: selection.anchor ?? focus ?? null };
}

/**
 * The selection after the list changed (a refresh, a filter): names no longer there drop out.
 * Answers the same object when nothing changed, so a store update can be skipped.
 */
export function reconcileSelection(selection: Selection, names: readonly string[]): Selection {
  const present = new Set(names);
  const selected = inOrder(names, new Set(selection.selected));
  const focusKept = selection.focus !== null && present.has(selection.focus);
  const anchorKept = selection.anchor !== null && present.has(selection.anchor);
  if (
    selected.length === selection.selected.length &&
    selected.every((name, index) => name === selection.selected[index]) &&
    (focusKept || selection.focus === null) &&
    (anchorKept || selection.anchor === null)
  ) {
    return selection;
  }
  const focus = focusKept ? selection.focus : (selected.at(-1) ?? null);
  const anchor = anchorKept ? selection.anchor : focus;
  if (selected.length === 0 && !focusKept) return EMPTY_SELECTION;
  return { selected, focus, anchor };
}
