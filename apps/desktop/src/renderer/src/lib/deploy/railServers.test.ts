import type { DeployServer } from '@shared/deployTypes';
import { describe, expect, it } from 'vitest';
import { applyPicks, chosenServers, moveId } from './railServers';

/**
 * Deploy shows the servers the user chose, in the order they put them in. These are the rules for
 * turning the saved choice and the list of every saved server into what the rail lists.
 */

function server(id: string): DeployServer {
  return {
    id,
    nickname: id.toUpperCase(),
    host: `${id}.example`,
    port: 22,
    username: 'deployer',
    core: null,
    enrolled: false,
  };
}

const ALL = ['a', 'b', 'c', 'd'].map(server);

describe('chosenServers', () => {
  it('lists only the chosen servers', () => {
    expect(chosenServers(ALL, ['b', 'd']).map((one) => one.id)).toEqual(['b', 'd']);
  });

  it('follows the order of the choice, not the order the servers were saved in', () => {
    expect(chosenServers(ALL, ['c', 'a', 'b']).map((one) => one.id)).toEqual(['c', 'a', 'b']);
  });

  it('shows nothing until the user has chosen something', () => {
    expect(chosenServers(ALL, [])).toEqual([]);
  });

  it('skips a chosen server that is not saved any more', () => {
    expect(chosenServers(ALL, ['gone', 'a']).map((one) => one.id)).toEqual(['a']);
  });

  it('lists a server once, even if the choice names it twice', () => {
    expect(chosenServers(ALL, ['a', 'b', 'a']).map((one) => one.id)).toEqual(['a', 'b']);
  });

  it('hands back the server objects it was given', () => {
    expect(chosenServers(ALL, ['b'])[0]).toBe(ALL[1]);
  });
});

describe('applyPicks', () => {
  it('keeps the order the chosen servers already had', () => {
    expect(applyPicks(['c', 'a'], ALL, new Set(['a', 'c']))).toEqual(['c', 'a']);
  });

  it('puts a newly picked server after the ones already chosen', () => {
    expect(applyPicks(['c'], ALL, new Set(['a', 'c']))).toEqual(['c', 'a']);
  });

  it('adds several new servers in the order they were saved in', () => {
    expect(applyPicks([], ALL, new Set(['d', 'b']))).toEqual(['b', 'd']);
  });

  it('drops a server that was unpicked', () => {
    expect(applyPicks(['a', 'b', 'c'], ALL, new Set(['a', 'c']))).toEqual(['a', 'c']);
  });

  it('forgets a chosen server that is not saved any more', () => {
    expect(applyPicks(['gone', 'a'], ALL, new Set(['a']))).toEqual(['a']);
  });

  it('ends up with nothing when everything is unpicked', () => {
    expect(applyPicks(['a', 'b'], ALL, new Set())).toEqual([]);
  });
});

describe('moveId', () => {
  it('moves an id later in the list', () => {
    expect(moveId(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an id earlier in the list', () => {
    expect(moveId(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('leaves the order alone when the id stays where it is', () => {
    expect(moveId(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('leaves the order alone when a place is off the list', () => {
    expect(moveId(['a', 'b', 'c'], 0, 3)).toEqual(['a', 'b', 'c']);
    expect(moveId(['a', 'b', 'c'], -1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('does not change the list it was given', () => {
    const ids = ['a', 'b', 'c'];
    moveId(ids, 0, 2);
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});
