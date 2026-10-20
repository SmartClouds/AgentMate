import type { DeployServer } from '@shared/deployTypes';

/**
 * Which servers the Deploy rail lists, and in what order. Every saved server can be deployed to,
 * but the rail only shows the ones the user chose, in the order they arranged them. The choice is
 * a list of server ids (the `deployServerIds` setting).
 */

/**
 * The servers the rail lists: those the choice names, in the choice's order. An id that matches no
 * saved server (one removed in Remote) is skipped, and an id named twice counts once.
 */
export function chosenServers(
  servers: readonly DeployServer[],
  chosenIds: readonly string[],
): DeployServer[] {
  const byId = new Map(servers.map((server) => [server.id, server]));
  const shown = new Set<string>();
  const chosen: DeployServer[] = [];
  for (const id of chosenIds) {
    const server = byId.get(id);
    if (!server || shown.has(id)) continue;
    shown.add(id);
    chosen.push(server);
  }
  return chosen;
}

/**
 * The new choice after the picker closes. Servers that stay picked keep their place, the ones just
 * picked join at the end in the order they were saved in, and anything unpicked, or no longer
 * saved, drops out.
 */
export function applyPicks(
  chosenIds: readonly string[],
  servers: readonly { id: string }[],
  picked: ReadonlySet<string>,
): string[] {
  const saved = new Set(servers.map((server) => server.id));
  const kept = [...new Set(chosenIds)].filter((id) => picked.has(id) && saved.has(id));
  const added = servers.map((server) => server.id).filter((id) => picked.has(id));
  return [...kept, ...added.filter((id) => !kept.includes(id))];
}

/** `ids` with the one at `from` moved to `to`. A place off the list leaves the order as it was. */
export function moveId(ids: readonly string[], from: number, to: number): string[] {
  const moved = [...ids];
  if (from === to || !(from in moved) || to < 0 || to >= moved.length) return moved;
  const [id] = moved.splice(from, 1);
  moved.splice(to, 0, id);
  return moved;
}
