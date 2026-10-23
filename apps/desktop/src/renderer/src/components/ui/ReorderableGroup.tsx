import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** What the group hands each item: where it sits, whether it's held, and the grip that moves it. */
export interface ReorderMotion {
  /** Spread on the item's root element. The group finds its items by `data-reorder-id`. */
  itemProps: { 'data-reorder-id': string; style?: React.CSSProperties };
  /** True for the item under the pointer, so the caller can lift it and stop its own transitions. */
  dragging: boolean;
  /**
   * True once the pointer has really moved. A plain press is `dragging` too, so an item that
   * should only look lifted when it is being moved, such as a tab you also click, reads this.
   */
  lifted: boolean;
  /** Goes on the grip's `onPointerDown`. The grip is the only thing that starts a drag. */
  onGripPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
}

interface ReorderableGroupProps<T> {
  items: T[];
  getId: (item: T) => string;
  /** False while the whole order isn't on screen, such as during a search. Grips then do nothing. */
  enabled: boolean;
  /** Called once per drop that changes the order, with the item's index before and after. */
  onMove: (fromIndex: number, toIndex: number) => void;
  className?: string;
  /** The element the items sit in. A list of rows can be an `ol`, a grid a `div`. */
  as?: 'div' | 'ol' | 'ul';
  /** Rendered before the items, for placeholders or a heading that aren't items themselves. */
  leading?: React.ReactNode;
  renderItem: (item: T, motion: ReorderMotion, index: number) => React.ReactNode;
}

/** An item's place in the group. Offsets ignore transforms, so a box still easing reads true. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/** One pointer drag, from the grip going down to the pointer letting go. */
interface Drag {
  pointerId: number;
  /** The grip the press landed on. It takes the pointer once the press becomes a real drag. */
  grip: HTMLElement;
  startX: number;
  startY: number;
  /** The dragged item's id, to tell whether the items changed under the drag. */
  id: string;
  /** Index the item started at. */
  from: number;
  /** Index it lands at if released now. */
  to: number;
  /** Pointer travel since the grip went down, clamped so the item stays inside the group. */
  offset: Point;
  /** True once the pointer has really moved, so the click that follows a drag can be swallowed. */
  travelled: boolean;
  /** Where every item sat when the drag began. Items don't reflow mid-drag, so these hold. */
  boxes: Box[];
  /** The area the items fill, which the dragged item can't leave. */
  bounds: { left: number; top: number; right: number; bottom: number };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** An item's layout box. Offsets are blind to transforms, so a row or card still easing reads true. */
function boxOf(element: HTMLElement): Box {
  return {
    left: element.offsetLeft,
    top: element.offsetTop,
    width: element.offsetWidth,
    height: element.offsetHeight,
  };
}

/** The step that takes a box to another box's place. */
function between(to: Box, from: Box): Point {
  return { x: to.left - from.left, y: to.top - from.top };
}

function toCss({ x, y }: Point): string {
  return `translate(${x}px, ${y}px)`;
}

/**
 * A press that became a drag ends on the item it started on, so the browser would also send a
 * click there. This eats that one click, so releasing a dragged item doesn't also open it.
 *
 * Chromium sends that click in the same task as the pointerup, or not at all (as on the macOS CI
 * runner). So the swallower goes on the next task: left up any longer, it ate the next real click
 * instead, and a tile clicked right after a drag did not open.
 */
function swallowClickAfterDrag(): void {
  const swallow = (event: MouseEvent): void => {
    event.stopPropagation();
    event.preventDefault();
  };
  // Under test the environment can be torn down by the time the timer fires. Vitest's window is the
  // global itself and teardown deletes its DOM methods, so a kept handle still loses them. With no
  // window left there is no listener to remove.
  const view = window;
  view.addEventListener('click', swallow, { capture: true, once: true });
  view.setTimeout(() => {
    if (typeof view.removeEventListener === 'function') {
      view.removeEventListener('click', swallow, { capture: true });
    }
  }, 0);
}

/**
 * Whether the items all sit on one line, like the tabs of a strip. Their widths can differ there,
 * so an item can't take the place of its neighbor: it has to make way by the dragged item's width.
 */
function inOneRow(boxes: Box[]): boolean {
  return boxes.length > 1 && boxes.every((box) => box.top === boxes[0].top);
}

/**
 * How far an item that isn't being dragged moves. The items between the dragged item's start and
 * its target each step one place toward the gap it leaves. In a grid that step can cross a row.
 */
function shiftFor({ from, to, boxes }: Drag, index: number): Point {
  if (inOneRow(boxes)) {
    // Left to right. The gap is the space between two neighbors, taken from the first pair.
    const gap = boxes[1].left - boxes[0].left - boxes[0].width;
    const room = boxes[from].width + gap;
    if (from < to && index > from && index <= to) return { x: -room, y: 0 };
    if (to < from && index >= to && index < from) return { x: room, y: 0 };
    return { x: 0, y: 0 };
  }
  if (from < to && index > from && index <= to) return between(boxes[index - 1], boxes[index]);
  if (to < from && index >= to && index < from) return between(boxes[index + 1], boxes[index]);
  return { x: 0, y: 0 };
}

/**
 * A group of items, a list or a grid, whose items make room while one is dragged. The dragged item
 * follows the pointer, the items it passes slide into the gap it leaves, and the drop settles the
 * item into its new place.
 *
 * The group keeps the order it was dropped into, so items never snap back while the caller's data
 * catches up. It takes the caller's order again whenever `items` changes.
 */
export function ReorderableGroup<T>({
  items,
  getId,
  enabled,
  onMove,
  className,
  as = 'div',
  leading,
  renderItem,
}: ReorderableGroupProps<T>): React.JSX.Element {
  const [order, setOrder] = useState(items);
  const [source, setSource] = useState(items);
  if (items !== source) {
    setSource(items);
    setOrder(items);
  }

  // Only the list semantics differ between the tags, so the ref is typed as a div.
  const Tag = as as 'div';
  const groupRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Where each item was being held when the last drop landed.
  const heldRef = useRef<Map<string, Point> | null>(null);

  // Runs before paint, so no item shows its pre-drop spot. Each one that moved starts where it was
  // held, and releasing that transform lets the transition carry it the rest of the way.
  useLayoutEffect(() => {
    const held = heldRef.current;
    const group = groupRef.current;
    if (!held || !group) return;
    heldRef.current = null;
    const elements = Array.from(group.querySelectorAll<HTMLElement>(':scope > [data-reorder-id]'));
    // Transitions go off before anything is read, so the layout reads below can't start one.
    for (const element of elements) {
      element.style.transition = 'none';
    }
    for (const element of elements) {
      const start = held.get(element.dataset.reorderId ?? '');
      if (!start) continue;
      const gap = { x: start.x - element.offsetLeft, y: start.y - element.offsetTop };
      element.style.transform = gap.x || gap.y ? toCss(gap) : '';
    }
    // Reading layout applies those starting spots, so the release below is the change that moves.
    group.getBoundingClientRect();
    for (const element of elements) {
      element.style.transition = '';
      element.style.transform = '';
    }
  });

  function begin(event: React.PointerEvent<HTMLElement>, index: number): void {
    const group = groupRef.current;
    if (!enabled || !group || event.button !== 0) return;
    event.preventDefault();
    // The pointer is not captured yet. A grip can wrap a button (a rail tile does), and a captured
    // pointer sends the click that follows to the grip rather than to the button inside it, so a
    // plain press and release would never open anything. Capture waits for real movement.
    const boxes = Array.from(
      group.querySelectorAll<HTMLElement>(':scope > [data-reorder-id]'),
      boxOf,
    );
    const next: Drag = {
      pointerId: event.pointerId,
      grip: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      id: getId(order[index]),
      from: index,
      to: index,
      offset: { x: 0, y: 0 },
      boxes,
      travelled: false,
      bounds: {
        left: Math.min(...boxes.map((box) => box.left)),
        top: Math.min(...boxes.map((box) => box.top)),
        right: Math.max(...boxes.map((box) => box.left + box.width)),
        bottom: Math.max(...boxes.map((box) => box.top + box.height)),
      },
    };
    dragRef.current = next;
    setDrag(next);
  }

  function move(event: React.PointerEvent<HTMLElement>): void {
    const current = dragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const { from, boxes, bounds } = current;
    const home = boxes[from];
    const pointer = { x: event.clientX - current.startX, y: event.clientY - current.startY };
    const offset = {
      x: clamp(pointer.x, bounds.left - home.left, bounds.right - (home.left + home.width)),
      y: clamp(pointer.y, bounds.top - home.top, bounds.bottom - (home.top + home.height)),
    };
    // The item lands in the box whose middle is nearest the middle of the item as it's held now.
    const middleX = home.left + home.width / 2 + offset.x;
    const middleY = home.top + home.height / 2 + offset.y;
    let to = from;
    let nearest = Number.POSITIVE_INFINITY;
    boxes.forEach((box, index) => {
      const distance = Math.hypot(
        box.left + box.width / 2 - middleX,
        box.top + box.height / 2 - middleY,
      );
      if (distance < nearest) {
        nearest = distance;
        to = index;
      }
    });
    const travelled =
      current.travelled ||
      Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 3;
    if (
      offset.x === current.offset.x &&
      offset.y === current.offset.y &&
      to === current.to &&
      travelled === current.travelled
    ) {
      return;
    }
    // From here the pointer belongs to the drag, so it keeps reaching the group wherever it goes.
    if (travelled && !current.travelled) current.grip.setPointerCapture(event.pointerId);
    const next = { ...current, offset, to, travelled };
    dragRef.current = next;
    setDrag(next);
  }

  function end(event: React.PointerEvent<HTMLElement>, commit: boolean): void {
    const current = dragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (current.travelled) swallowClickAfterDrag();
    const dragged = order[current.from];
    // If the items changed under the drag (a refresh, say), the item isn't where the drag began, so
    // the drop is skipped rather than moving whatever is there now.
    if (!commit || current.to === current.from || !dragged || getId(dragged) !== current.id) {
      return;
    }
    // Where each item is held right now. Its glide after the drop starts from there.
    const held = new Map<string, Point>();
    order.forEach((item, index) => {
      const box = current.boxes[index];
      const shift = index === current.from ? current.offset : shiftFor(current, index);
      held.set(getId(item), { x: box.left + shift.x, y: box.top + shift.y });
    });
    heldRef.current = held;
    const next = [...order];
    const [moved] = next.splice(current.from, 1);
    next.splice(current.to, 0, moved);
    setOrder(next);
    onMove(current.from, current.to);
  }

  return (
    <Tag
      ref={groupRef}
      className={cn(className, drag && 'select-none')}
      onPointerMove={move}
      onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)}
      onLostPointerCapture={(event) => end(event, false)}
    >
      {leading}
      {order.map((item, index) => {
        const id = getId(item);
        const dragging = drag?.from === index;
        let shift: Point = { x: 0, y: 0 };
        if (drag) shift = dragging ? drag.offset : shiftFor(drag, index);
        const moved = shift.x !== 0 || shift.y !== 0;
        const motion: ReorderMotion = {
          itemProps: {
            'data-reorder-id': id,
            style:
              moved || dragging
                ? { transform: toCss(shift), zIndex: dragging ? 10 : undefined }
                : undefined,
          },
          dragging,
          lifted: Boolean(dragging && drag?.travelled),
          onGripPointerDown: (event) => begin(event, index),
        };
        return <Fragment key={id}>{renderItem(item, motion, index)}</Fragment>;
      })}
    </Tag>
  );
}
