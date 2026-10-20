import { describe, expect, it } from 'vitest';
import {
  clickSelect,
  EMPTY_SELECTION,
  moveFocus,
  reconcileSelection,
  type Selection,
  selectAll,
} from './selection';

const NAMES = ['a', 'b', 'c', 'd', 'e'];

function sel(selected: string[], focus: string | null = null, anchor = focus): Selection {
  return { selected, focus, anchor };
}

describe('clickSelect', () => {
  it('selects just the clicked row', () => {
    expect(clickSelect(sel(['a', 'b'], 'b'), NAMES, 'd', {})).toEqual(sel(['d'], 'd'));
  });

  it('toggles a row with Ctrl', () => {
    expect(clickSelect(sel(['a'], 'a'), NAMES, 'c', { toggle: true })).toEqual(
      sel(['a', 'c'], 'c'),
    );
    expect(clickSelect(sel(['a', 'c'], 'c'), NAMES, 'a', { toggle: true })).toEqual(
      sel(['c'], 'a'),
    );
  });

  it('selects a range from the anchor with Shift, in list order', () => {
    expect(clickSelect(sel(['b'], 'b'), NAMES, 'd', { range: true })).toEqual(
      sel(['b', 'c', 'd'], 'd', 'b'),
    );
    expect(clickSelect(sel(['b', 'c', 'd'], 'd', 'b'), NAMES, 'a', { range: true })).toEqual(
      sel(['a', 'b'], 'a', 'b'),
    );
  });

  it('starts a range at the clicked row when there is no anchor', () => {
    expect(clickSelect(EMPTY_SELECTION, NAMES, 'c', { range: true })).toEqual(sel(['c'], 'c'));
  });
});

describe('moveFocus', () => {
  it('moves and selects with the arrows', () => {
    expect(moveFocus(sel(['b'], 'b'), NAMES, 1, {})).toEqual(sel(['c'], 'c'));
    expect(moveFocus(sel(['b'], 'b'), NAMES, -1, {})).toEqual(sel(['a'], 'a'));
  });

  it('stops at the ends, and Home and End jump there', () => {
    expect(moveFocus(sel(['e'], 'e'), NAMES, 1, {})).toEqual(sel(['e'], 'e'));
    expect(moveFocus(sel(['a'], 'a'), NAMES, -1, {})).toEqual(sel(['a'], 'a'));
    expect(moveFocus(sel(['c'], 'c'), NAMES, 'end', {})).toEqual(sel(['e'], 'e'));
    expect(moveFocus(sel(['c'], 'c'), NAMES, 'home', {})).toEqual(sel(['a'], 'a'));
  });

  it('starts at the first row when nothing has focus', () => {
    expect(moveFocus(EMPTY_SELECTION, NAMES, 1, {})).toEqual(sel(['a'], 'a'));
    expect(moveFocus(EMPTY_SELECTION, NAMES, -1, {})).toEqual(sel(['e'], 'e'));
    expect(moveFocus(EMPTY_SELECTION, [], 1, {})).toEqual(EMPTY_SELECTION);
  });

  it('extends from the anchor with Shift', () => {
    const one = moveFocus(sel(['b'], 'b'), NAMES, 1, { extend: true });
    expect(one).toEqual(sel(['b', 'c'], 'c', 'b'));
    const two = moveFocus(one, NAMES, 1, { extend: true });
    expect(two).toEqual(sel(['b', 'c', 'd'], 'd', 'b'));
    expect(moveFocus(two, NAMES, -1, { extend: true })).toEqual(sel(['b', 'c'], 'c', 'b'));
  });
});

describe('selectAll and Escape', () => {
  it('selects every row and keeps the focus', () => {
    expect(selectAll(sel(['b'], 'b'), NAMES)).toEqual({ selected: NAMES, focus: 'b', anchor: 'b' });
    expect(selectAll(EMPTY_SELECTION, NAMES).focus).toBe('a');
  });
});

describe('reconcileSelection', () => {
  it('keeps the names still listed after a refresh', () => {
    const before = sel(['b', 'd'], 'd', 'b');
    expect(reconcileSelection(before, ['a', 'b', 'c', 'd'])).toBe(before);
    expect(reconcileSelection(before, ['a', 'd', 'x'])).toEqual(sel(['d'], 'd'));
  });

  it('moves the focus to a kept row when the focused one went away', () => {
    expect(reconcileSelection(sel(['b', 'd'], 'd', 'b'), ['a', 'b'])).toEqual(sel(['b'], 'b', 'b'));
    expect(reconcileSelection(sel(['d'], 'd'), ['a'])).toEqual(EMPTY_SELECTION);
  });
});
