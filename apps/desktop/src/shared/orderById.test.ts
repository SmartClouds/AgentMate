import { describe, expect, it } from 'vitest';
import { orderById } from './orderById';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('orderById', () => {
  it('follows the order it is given', () => {
    expect(orderById(items, ['c', 'a', 'b']).map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps the items themselves, not copies', () => {
    expect(orderById(items, ['b', 'a', 'c'])[0]).toBe(items[1]);
  });

  it('puts items the list leaves out at the end, in their own order', () => {
    expect(orderById(items, ['c']).map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });

  it('drops ids that match nothing and counts a repeated id once', () => {
    expect(orderById(items, ['gone', 'b', 'b', 'a']).map((item) => item.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('leaves the input alone', () => {
    const before = items.map((item) => item.id);
    orderById(items, ['c', 'b', 'a']);
    expect(items.map((item) => item.id)).toEqual(before);
  });
});
