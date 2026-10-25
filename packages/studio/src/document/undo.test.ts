import { describe, expect, it } from 'vitest';
import { computeUndoStack, type TxRef } from './undo.js';

const edit = (seq: number): TxRef => ({ seq, kind: 'edit', of: null });
const undo = (seq: number, of: number): TxRef => ({ seq, kind: 'undo', of });
const redo = (seq: number, of: number): TxRef => ({ seq, kind: 'redo', of });

describe('computeUndoStack', () => {
  it('stacks edits, newest last', () => {
    expect(computeUndoStack([edit(1), edit(2), edit(3)])).toEqual({ undo: [1, 2, 3], redo: [] });
  });

  it('moves an undone edit to the redo stack, as the undo entry that can be redone', () => {
    expect(computeUndoStack([edit(1), edit(2), undo(3, 2)])).toEqual({ undo: [1], redo: [3] });
  });

  it('puts a redone edit back on the undo stack, as the redo entry', () => {
    expect(computeUndoStack([edit(1), edit(2), undo(3, 2), redo(4, 3)])).toEqual({
      undo: [1, 4],
      redo: [],
    });
  });

  it('can undo all the way back and redo all the way forward', () => {
    const log = [edit(1), edit(2), undo(3, 2), undo(4, 1), redo(5, 4), redo(6, 3)];
    expect(computeUndoStack(log)).toEqual({ undo: [5, 6], redo: [] });
    expect(computeUndoStack(log.slice(0, 4))).toEqual({ undo: [], redo: [3, 4] });
  });

  it('clears the redo stack when a new edit lands', () => {
    expect(computeUndoStack([edit(1), undo(2, 1), edit(3)])).toEqual({ undo: [3], redo: [] });
  });

  it('starts both stacks over when the log does not add up, rather than undoing the wrong thing', () => {
    expect(computeUndoStack([edit(1), edit(2), undo(3, 1)])).toEqual({ undo: [], redo: [] });
    expect(computeUndoStack([edit(1), redo(2, 7), edit(3)])).toEqual({ undo: [3], redo: [] });
  });

  it('never offers to undo past a mark, such as the video being created', () => {
    const log: TxRef[] = [{ seq: 1, kind: 'mark', of: null }, edit(2)];
    expect(computeUndoStack(log)).toEqual({ undo: [2], redo: [] });
    expect(computeUndoStack([edit(1), { seq: 2, kind: 'mark', of: null }])).toEqual({
      undo: [],
      redo: [],
    });
  });
});
