import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SaveRecipeInput } from '../../api.js';
import { useTempDirs } from '../../test/tempDir.js';
import { RecipeStore } from './recipeStore.js';

const tempDir = useTempDirs();

const input: SaveRecipeInput = {
  name: 'Product explainer',
  brief: 'A 45 second explainer for {product}',
  styleId: 'flat-vector',
  language: 'fa',
  aspect: '9:16',
  targetSeconds: 45,
  scenario: { cliId: 'claude-code', model: 'opus', effort: 'high' },
};

async function store() {
  let clock = 100;
  let n = 0;
  const file = join(await tempDir(), 'recipes.json');
  const make = () =>
    new RecipeStore(
      file,
      () => clock++,
      () => `r${++n}`,
    );
  return { make, recipes: make() };
}

describe('RecipeStore', () => {
  it('saves a recipe and lists it after a restart', async () => {
    const { make, recipes } = await store();
    const saved = await recipes.save(input);
    expect(saved).toMatchObject({ ...input, id: 'r1', createdAt: 100, updatedAt: 100 });
    expect(await make().list()).toEqual([saved]);
  });

  it('updates a recipe in place and lists the newest change first', async () => {
    const { recipes } = await store();
    const first = await recipes.save(input);
    await recipes.save({ ...input, name: 'Second' });
    const updated = await recipes.save({ ...input, id: first.id, name: 'Renamed' });
    expect(updated).toMatchObject({ id: first.id, name: 'Renamed', createdAt: first.createdAt });
    expect((await recipes.list()).map((r) => r.name)).toEqual(['Renamed', 'Second']);
  });

  it('refuses to update a recipe that was deleted', async () => {
    const { recipes } = await store();
    const saved = await recipes.save(input);
    await recipes.remove(saved.id);
    expect(await recipes.list()).toEqual([]);
    await expect(recipes.save({ ...input, id: saved.id })).rejects.toThrow(/not saved any more/);
  });
});
