/**
 * Undo and redo over an append-only log. Nothing is ever taken out of the history: undoing an
 * edit appends an "undo" entry that applies the edit's inverse, and redoing appends a "redo"
 * entry. The stacks are therefore a function of the log alone, rebuilt here, which is why undo
 * still works after the app restarts or crashes.
 *
 * - edit: pushed on the undo stack; the redo stack is cleared.
 * - undo of X (X is the top of the undo stack): X leaves it, and the undo entry goes on the redo
 *   stack. Redoing applies that entry's inverse.
 * - redo of U (U is the top of the redo stack): U leaves it, and the redo entry goes on the undo
 *   stack, so it can be undone again like any edit.
 * - mark: a point undo never crosses, such as the video being created or a restore from a backup.
 */

export interface TxRef {
  seq: number;
  kind: 'edit' | 'undo' | 'redo' | 'mark';
  /** The entry an undo or redo acts on. */
  of: number | null;
}

export interface UndoStacks {
  /** Entries that can be undone, the next one last. */
  undo: number[];
  /** Entries that can be redone, the next one last. */
  redo: number[];
}

export function computeUndoStack(log: readonly TxRef[]): UndoStacks {
  const stacks: UndoStacks = { undo: [], redo: [] };
  for (const tx of log) pushTx(stacks, tx);
  return stacks;
}

/**
 * Moves `stacks` on by one log entry, in place, so a long history is rebuilt in one linear pass
 * and a new edit costs nothing.
 */
export function pushTx(stacks: UndoStacks, tx: TxRef): void {
  if (tx.kind === 'edit') {
    stacks.undo.push(tx.seq);
    stacks.redo.length = 0;
    return;
  }
  const [from, to] = tx.kind === 'undo' ? [stacks.undo, stacks.redo] : [stacks.redo, stacks.undo];
  // A mark is a point undo never crosses. An undo or redo that does not match the top of its
  // stack means the log is not one this code wrote, and undoing anything after that could undo
  // the wrong change. Either way, start over.
  if (tx.kind === 'mark' || from.at(-1) !== tx.of) {
    stacks.undo.length = 0;
    stacks.redo.length = 0;
    return;
  }
  from.pop();
  to.push(tx.seq);
}
