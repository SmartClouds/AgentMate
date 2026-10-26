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

describe('recipe versions and files (E39)', () => {
  it('keeps every save as a version, and starts from any of them', async () => {
    const { recipes } = await store();
    const first = await recipes.save(input);
    await recipes.save({
      ...input,
      id: first.id,
      targetSeconds: 60,
      stages: { edit: { cliId: 'codex', model: 'gpt-6-luna', effort: 'medium' } },
      voiceRef: 'azure:fa-IR-DilaraNeural',
      render: { resolution: '1080p', fps: 30, quality: 'high', codec: 'h264' },
    });
    const [latest] = await recipes.list();
    expect(latest).toMatchObject({
      version: 2,
      versions: 2,
      targetSeconds: 60,
      voiceRef: 'azure:fa-IR-DilaraNeural',
    });
    expect((await recipes.versions(first.id)).map((v) => [v.version, v.targetSeconds])).toEqual([
      [2, 60],
      [1, 45],
    ]);
    expect(await recipes.version(first.id, 1)).toMatchObject({ version: 1, targetSeconds: 45 });
    await expect(recipes.version(first.id, 9)).rejects.toThrow(
      'That recipe version is not saved any more.',
    );
    await expect(recipes.versions('gone')).rejects.toThrow('That recipe is not saved any more.');
  });

  it('reads an E32 recipes file as the first version of each recipe', async () => {
    const dir = await tempDir();
    const file = join(dir, 'recipes.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        recipes: { old1: { ...input, id: 'old1', createdAt: 5, updatedAt: 7 } },
      }),
    );
    const recipes = new RecipeStore(
      file,
      () => 50,
      () => 'x',
    );
    expect(await recipes.list()).toEqual([
      expect.objectContaining({
        id: 'old1',
        name: 'Product explainer',
        version: 1,
        versions: 1,
        createdAt: 5,
        updatedAt: 7,
      }),
    ]);
    const next = await recipes.save({ ...input, id: 'old1', name: 'Again' });
    expect(next).toMatchObject({ version: 2, versions: 2 });
  });

  it('exports a recipe with its versions and imports it back as a new one, refusing a bad file', async () => {
    const { recipes, make } = await store();
    const first = await recipes.save(input);
    await recipes.save({ ...input, id: first.id, name: 'Explainer v2' });
    const exported = await recipes.exportText(first.id);
    expect(exported.name).toBe('Explainer v2');
    const other = make();
    const imported = await other.importText(exported.text);
    expect(imported).toMatchObject({ name: 'Explainer v2', version: 2, versions: 2 });
    expect(imported.id).not.toBe(first.id);
    await expect(other.importText('{ nope')).rejects.toThrow(
      'That is not a Studio recipe file, or it is damaged.',
    );
    const chinese = JSON.parse(exported.text);
    chinese.recipe.versions[0].language = String.fromCharCode(0x7a, 0x68);
    await expect(other.importText(JSON.stringify(chinese))).rejects.toThrow(
      'That is not a Studio recipe file',
    );
    await expect(recipes.exportText('gone')).rejects.toThrow('That recipe is not saved any more.');
  });
});
