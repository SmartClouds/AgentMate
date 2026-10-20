import { fireEvent } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * Jsdom has no layout, so a reorderable list reads every item as a 0x0 box and a drag has nowhere
 * to go. This gives each element a box by its place in its parent: a column of rows `rowHeight`
 * tall, all with the same left edge and width. Undo it with `vi.restoreAllMocks()`.
 */
export function mockStackedRows(rowHeight: number): void {
  const place = (element: HTMLElement): number =>
    Array.from(element.parentElement?.children ?? []).indexOf(element);
  const spy = (property: string, value: (index: number) => number): void => {
    vi.spyOn(HTMLElement.prototype, property as 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return value(place(this));
    });
  };
  spy('offsetLeft', () => 0);
  spy('offsetTop', (index) => index * rowHeight);
  spy('offsetWidth', () => 300);
  spy('offsetHeight', () => rowHeight);
}

/** Presses the grip of the item with this reorder id, drags it `distance` px down and lets go. */
export function dragItemDown(container: HTMLElement, id: string, distance: number): void {
  const grip = container
    .querySelector<HTMLElement>(`[data-reorder-id="${id}"]`)
    ?.querySelector<HTMLElement>('[data-drag-grip]');
  if (!grip) throw new Error(`${id} has no drag grip`);
  fireEvent.pointerDown(grip, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(grip, { clientX: 0, clientY: distance, pointerId: 1 });
  fireEvent.pointerUp(grip, { pointerId: 1 });
}

/** The reorder ids of a list's items, top to bottom. */
export function reorderIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-reorder-id]'), (item) =>
    String(item.dataset.reorderId),
  );
}

/** A finished drag swallows the next click for 300 ms. Call this after a test that dragged. */
export function settleDragClick(): void {
  window.dispatchEvent(new MouseEvent('click'));
}
