import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReorderableGroup, type ReorderMotion } from './ReorderableGroup';

interface Item {
  id: string;
  name: string;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const ITEMS: Item[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Bravo' },
  { id: 'c', name: 'Charlie' },
];

const FOUR: Item[] = [...ITEMS, { id: 'd', name: 'Delta' }];

/** Jsdom has no layout, so each test lays its items out: rows 60px tall, stacked flush. */
function stackedRows(count: number): Box[] {
  return Array.from({ length: count }, (_, index) => ({
    left: 0,
    top: index * 60,
    width: 300,
    height: 60,
  }));
}

/** Cards 280px wide and 180px tall, 300px apart across and 200px down, filled left to right. */
function gridCells(count: number, columns: number): Box[] {
  return Array.from({ length: count }, (_, index) => ({
    left: (index % columns) * 300,
    top: Math.floor(index / columns) * 200,
    width: 280,
    height: 180,
  }));
}

/** A strip of tabs: one line, `gap` apart, each as wide as its own width. */
function stripCells(widths: number[], gap: number): Box[] {
  let left = 0;
  return widths.map((width) => {
    const box = { left, top: 0, width, height: 28 };
    left += width + gap;
    return box;
  });
}

function Row({ item, motion }: { item: Item; motion: ReorderMotion }): React.JSX.Element {
  return (
    <div
      {...motion.itemProps}
      data-dragging={String(motion.dragging)}
      data-lifted={String(motion.lifted)}
    >
      <span data-testid={`grip-${item.id}`} onPointerDown={motion.onGripPointerDown} />
      {item.name}
    </div>
  );
}

function setup(
  props: {
    items?: Item[];
    enabled?: boolean;
    boxes?: Box[];
    /** Replaces the default row, for items whose grip holds something clickable. */
    row?: (item: Item, motion: ReorderMotion) => React.ReactNode;
  } = {},
) {
  const items = props.items ?? ITEMS;
  const boxes = props.boxes ?? stackedRows(items.length);
  // Layout follows the DOM: whichever item sits in a place reads that place's box.
  const boxFor = (element: HTMLElement): Box =>
    boxes[Array.from(element.parentElement?.children ?? []).indexOf(element)] ?? {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    };
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return boxFor(this).left;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return boxFor(this).top;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return boxFor(this).width;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return boxFor(this).height;
  });

  const onMove = vi.fn();
  const view = (list: Item[]) => (
    <ReorderableGroup
      items={list}
      getId={(item) => item.id}
      enabled={props.enabled ?? true}
      onMove={onMove}
      renderItem={(item, motion) =>
        props.row ? props.row(item, motion) : <Row item={item} motion={motion} />
      }
    />
  );
  const { container, rerender } = render(view(items));
  return { container, onMove, rerender: (list: Item[]) => rerender(view(list)) };
}

function grip(id: string): HTMLElement {
  return screen.getByTestId(`grip-${id}`);
}

function press(id: string, x: number, y: number): void {
  fireEvent.pointerDown(grip(id), { button: 0, clientX: x, clientY: y, pointerId: 1 });
}

function moveTo(id: string, x: number, y: number): void {
  fireEvent.pointerMove(grip(id), { clientX: x, clientY: y, pointerId: 1 });
}

function release(id: string): void {
  fireEvent.pointerUp(grip(id), { pointerId: 1 });
}

function itemFor(container: HTMLElement, id: string): HTMLElement {
  const item = container.querySelector<HTMLElement>(`[data-reorder-id="${id}"]`);
  if (!item) throw new Error(`No item for ${id}`);
  return item;
}

function orderOf(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-reorder-id]'), (item) =>
    String(item.dataset.reorderId),
  );
}

afterEach(() => {
  // A drop that travelled leaves a one-shot click swallower on the window for 300ms. Spend it, or
  // it eats the first click of whichever test runs next.
  window.dispatchEvent(new MouseEvent('click'));
  vi.restoreAllMocks();
});

describe('ReorderableGroup', () => {
  it('renders the items in the order it was given', () => {
    const { container } = setup();
    expect(orderOf(container)).toEqual(['a', 'b', 'c']);
  });

  it('moves the dragged item with the pointer and slides the item it passes', () => {
    const { container, onMove } = setup();
    press('a', 0, 0);
    moveTo('a', 0, 70);

    expect(itemFor(container, 'a').style.transform).toBe('translate(0px, 70px)');
    expect(itemFor(container, 'a').dataset.dragging).toBe('true');
    expect(itemFor(container, 'b').style.transform).toBe('translate(0px, -60px)');
    expect(itemFor(container, 'c').style.transform).toBe('');

    release('a');
    expect(onMove).toHaveBeenCalledWith(0, 1);
    expect(orderOf(container)).toEqual(['b', 'a', 'c']);
    // The landed item is handed back to its own transitions, with nothing left inline.
    expect(itemFor(container, 'a').style.transform).toBe('');
    expect(itemFor(container, 'a').style.transition).toBe('');
  });

  it('slides the items down when one is dragged up past them', () => {
    const { container, onMove } = setup();
    press('c', 0, 200);
    moveTo('c', 0, 100);

    expect(itemFor(container, 'a').style.transform).toBe('translate(0px, 60px)');
    expect(itemFor(container, 'b').style.transform).toBe('translate(0px, 60px)');

    release('c');
    expect(onMove).toHaveBeenCalledWith(2, 0);
    expect(orderOf(container)).toEqual(['c', 'a', 'b']);
  });

  it('keeps the dragged item inside the group', () => {
    const { container, onMove } = setup();
    press('a', 0, 0);
    moveTo('a', 0, 900);
    expect(itemFor(container, 'a').style.transform).toBe('translate(0px, 120px)');

    release('a');
    expect(onMove).toHaveBeenCalledWith(0, 2);
    expect(orderOf(container)).toEqual(['b', 'c', 'a']);
  });

  it('does not reorder when the item is dropped where it started', () => {
    const { container, onMove } = setup();
    press('b', 0, 100);
    moveTo('b', 0, 110);
    release('b');

    expect(onMove).not.toHaveBeenCalled();
    expect(orderOf(container)).toEqual(['a', 'b', 'c']);
    expect(itemFor(container, 'b').style.transform).toBe('');
  });

  it('drops nothing when the drag is cancelled', () => {
    const { container, onMove } = setup();
    press('a', 0, 0);
    moveTo('a', 0, 70);
    fireEvent.pointerCancel(grip('a'), { pointerId: 1 });

    expect(onMove).not.toHaveBeenCalled();
    expect(orderOf(container)).toEqual(['a', 'b', 'c']);
    expect(itemFor(container, 'a').style.transform).toBe('');
  });

  it('ignores grips while the order is locked', () => {
    const { container, onMove } = setup({ enabled: false });
    press('a', 0, 0);
    moveTo('a', 0, 70);
    release('a');

    expect(onMove).not.toHaveBeenCalled();
    expect(itemFor(container, 'a').style.transform).toBe('');
  });

  it('holds the dropped order until the caller hands it new items', () => {
    const { container, onMove } = setup();
    press('a', 0, 0);
    moveTo('a', 0, 70);
    release('a');

    // Nothing has reloaded yet, so the list keeps the order it was dropped into.
    expect(onMove).toHaveBeenCalledWith(0, 1);
    expect(orderOf(container)).toEqual(['b', 'a', 'c']);
  });

  it("takes the caller's order again once its items change", () => {
    const { container, rerender } = setup();
    press('a', 0, 0);
    moveTo('a', 0, 70);
    release('a');
    expect(orderOf(container)).toEqual(['b', 'a', 'c']);

    rerender([...ITEMS]);
    expect(orderOf(container)).toEqual(['a', 'b', 'c']);
  });

  describe('pointer capture', () => {
    /** Records which element is asked to hold the pointer, as Chromium would honour it. */
    function trackCapture(): Element[] {
      const held: Element[] = [];
      vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(function (this: Element) {
        held.push(this);
      });
      return held;
    }

    it('leaves the pointer alone on a press that never moves', () => {
      const held = trackCapture();
      setup();
      press('a', 0, 0);
      release('a');
      expect(held).toEqual([]);
    });

    it('leaves the pointer alone on a press that only jitters', () => {
      const held = trackCapture();
      setup();
      press('a', 0, 0);
      moveTo('a', 1, 1);
      moveTo('a', 2, 0);
      release('a');
      expect(held).toEqual([]);
    });

    it('takes the pointer once, on the grip, when the press becomes a drag', () => {
      const held = trackCapture();
      setup();
      press('a', 0, 0);
      moveTo('a', 0, 10);
      moveTo('a', 0, 30);
      moveTo('a', 0, 70);
      expect(held).toEqual([grip('a')]);
      release('a');
    });

    // Chromium sends the click that ends a press to the element holding the pointer, and to the
    // element under it otherwise. A grip that held the pointer on press therefore swallowed the
    // click of any button inside it, so no rail tile could be opened.
    it('lets a click reach a button inside the grip after a press that did not move', () => {
      const held = trackCapture();
      const onOpen = vi.fn();
      setup({
        row: (item, motion) => (
          <div {...motion.itemProps}>
            <div onPointerDown={motion.onGripPointerDown}>
              <button type="button" onClick={() => onOpen(item.id)}>
                {`Open ${item.name}`}
              </button>
            </div>
          </div>
        ),
      });
      const button = screen.getByRole('button', { name: 'Open Alpha' });

      fireEvent.pointerDown(button, { button: 0, clientX: 4, clientY: 4, pointerId: 1 });
      fireEvent.pointerUp(button, { pointerId: 1 });
      fireEvent.click(held.at(-1) ?? button);

      expect(onOpen).toHaveBeenCalledWith('a');
    });

    it('eats the click that follows a drag, wherever it lands', () => {
      trackCapture();
      const onOpen = vi.fn();
      const { onMove } = setup({
        row: (item, motion) => (
          <div {...motion.itemProps}>
            <div onPointerDown={motion.onGripPointerDown}>
              <button type="button" onClick={() => onOpen(item.id)}>
                {`Open ${item.name}`}
              </button>
            </div>
          </div>
        ),
      });
      const button = screen.getByRole('button', { name: 'Open Alpha' });

      fireEvent.pointerDown(button, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(button, { clientX: 0, clientY: 70, pointerId: 1 });
      fireEvent.pointerUp(button, { pointerId: 1 });
      fireEvent.click(button);

      expect(onMove).toHaveBeenCalledWith(0, 1);
      expect(onOpen).not.toHaveBeenCalled();
    });

    // Vitest's jsdom window is the global itself, and tearing the environment down deletes its
    // DOM methods. A drag at the end of a test file left the timer to fire after that and throw,
    // which failed the whole run as an unhandled error.
    it('leaves the window alone when the test environment is gone before the click timer fires', () => {
      vi.useFakeTimers();
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
      try {
        setup();
        press('a', 0, 0);
        moveTo('a', 0, 70);
        release('a');

        // As teardown does: the method is gone from the global, not replaced.
        Reflect.deleteProperty(globalThis, 'removeEventListener');
        expect(() => vi.advanceTimersByTime(300)).not.toThrow();
      } finally {
        if (descriptor) Object.defineProperty(globalThis, 'removeEventListener', descriptor);
        vi.useRealTimers();
      }
    });
  });

  it('moves across a grid row and slides the cards it passes', () => {
    const { container, onMove } = setup({ items: FOUR, boxes: gridCells(4, 2) });
    press('a', 0, 0);
    moveTo('a', 300, 0);

    expect(itemFor(container, 'a').style.transform).toBe('translate(300px, 0px)');
    expect(itemFor(container, 'b').style.transform).toBe('translate(-300px, 0px)');
    expect(itemFor(container, 'c').style.transform).toBe('');

    release('a');
    expect(onMove).toHaveBeenCalledWith(0, 1);
    expect(orderOf(container)).toEqual(['b', 'a', 'c', 'd']);
  });

  describe('a single line of items with different widths', () => {
    // Alpha 100 wide, Bravo 60, Charlie 80, with 2px between them.
    const boxes = stripCells([100, 60, 80], 2);

    it('makes way by the width of the item held, not by the width of its neighbor', () => {
      const { container, onMove } = setup({ boxes });
      press('a', 0, 0);
      moveTo('a', 80, 0);

      // Alpha's middle is now at 130, nearest Bravo's. Bravo steps left by Alpha's 100 and the gap,
      // not by its own 60, which is what leaves the strip packed once Alpha lands.
      expect(itemFor(container, 'a').style.transform).toBe('translate(80px, 0px)');
      expect(itemFor(container, 'b').style.transform).toBe('translate(-102px, 0px)');
      expect(itemFor(container, 'c').style.transform).toBe('');

      // Far past the end, the item stops at the last tab's edge, and both tabs have made way.
      moveTo('a', 400, 0);
      expect(itemFor(container, 'a').style.transform).toBe('translate(144px, 0px)');
      expect(itemFor(container, 'b').style.transform).toBe('translate(-102px, 0px)');
      expect(itemFor(container, 'c').style.transform).toBe('translate(-102px, 0px)');

      release('a');
      expect(onMove).toHaveBeenCalledWith(0, 2);
      expect(orderOf(container)).toEqual(['b', 'c', 'a']);
    });

    it('makes way to the right when an item is dragged left', () => {
      const { container, onMove } = setup({ boxes });
      press('c', 0, 0);
      moveTo('c', -400, 0);

      // Charlie is 80 wide, so Alpha and Bravo each step right by 80 and the gap.
      expect(itemFor(container, 'a').style.transform).toBe('translate(82px, 0px)');
      expect(itemFor(container, 'b').style.transform).toBe('translate(82px, 0px)');

      release('c');
      expect(onMove).toHaveBeenCalledWith(2, 0);
      expect(orderOf(container)).toEqual(['c', 'a', 'b']);
    });

    it('does not lift an item for a press that never moved', () => {
      const { container } = setup({ boxes });
      press('b', 0, 0);
      expect(itemFor(container, 'b').dataset.dragging).toBe('true');
      expect(itemFor(container, 'b').dataset.lifted).toBe('false');

      moveTo('b', 1, 1);
      expect(itemFor(container, 'b').dataset.lifted).toBe('false');

      moveTo('b', 20, 0);
      expect(itemFor(container, 'b').dataset.lifted).toBe('true');
      expect(itemFor(container, 'a').dataset.lifted).toBe('false');

      release('b');
      expect(itemFor(container, 'b').dataset.lifted).toBe('false');
    });
  });

  it('moves down into the next grid row and shifts the cards in both directions', () => {
    const { container, onMove } = setup({ items: FOUR, boxes: gridCells(4, 2) });
    press('a', 0, 0);
    moveTo('a', 0, 200);

    expect(itemFor(container, 'a').style.transform).toBe('translate(0px, 200px)');
    // b steps left into a's old cell, and c steps from the first column of row two into b's.
    expect(itemFor(container, 'b').style.transform).toBe('translate(-300px, 0px)');
    expect(itemFor(container, 'c').style.transform).toBe('translate(300px, -200px)');
    expect(itemFor(container, 'd').style.transform).toBe('');

    release('a');
    expect(onMove).toHaveBeenCalledWith(0, 2);
    expect(orderOf(container)).toEqual(['b', 'c', 'a', 'd']);
  });
});
