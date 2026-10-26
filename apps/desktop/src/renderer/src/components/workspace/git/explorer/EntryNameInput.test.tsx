import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { installRunovaBridge } from '../../../../../../test/renderer/runovaBridge';
import { EntryNameInput } from './EntryNameInput';

function renderInTree(onTreeContextMenu: (event: React.MouseEvent) => void) {
  installRunovaBridge();
  return render(
    // The explorer tree sits around the name box and has a right-click handler of its own.
    <div onContextMenu={onTreeContextMenu}>
      <EntryNameInput
        projectId="p1"
        parent=""
        initial="notes.md"
        isDirectory={false}
        allowNested={false}
        onCommit={async () => true}
        onCancel={() => undefined}
      />
    </div>,
  );
}

describe('EntryNameInput right-click', () => {
  it('does not hand the right-click to the tree around it', () => {
    // The tree opens its own file menu on a right-click, and Radix opens it by cancelling
    // the event. Neither should happen over a name box, which is a text field with a menu
    // of its own.
    const treeHeardIt = vi.fn();
    renderInTree(treeHeardIt);

    fireEvent.contextMenu(screen.getByLabelText('New name for notes.md'));

    expect(treeHeardIt).not.toHaveBeenCalled();
  });

  it('leaves the event uncancelled, so the field menu can open', () => {
    // A cancelled right-click is never reported to the main process, which is where the
    // field menu (Cut, Copy, Paste, Select all) comes from.
    renderInTree(vi.fn());

    const notCancelled = fireEvent.contextMenu(screen.getByLabelText('New name for notes.md'));

    expect(notCancelled).toBe(true);
  });
});
