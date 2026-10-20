/**
 * `items` in the order `orderedIds` lists them. Ids that match nothing are dropped, a repeated id
 * counts once, and items the list leaves out (added while a drag was in flight) keep their
 * relative order at the end, so a reorder can never lose one.
 */
export function orderById<T extends { id: string }>(
  items: readonly T[],
  orderedIds: readonly string[],
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const placed = new Set<string>();
  const ordered: T[] = [];
  for (const id of orderedIds) {
    const item = byId.get(id);
    if (!item || placed.has(id)) continue;
    placed.add(id);
    ordered.push(item);
  }
  return [...ordered, ...items.filter((item) => !placed.has(item.id))];
}
