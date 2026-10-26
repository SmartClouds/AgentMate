import { z } from 'zod';
import { type RecipeView, type SaveRecipeInput, studioAiInputs } from '../../api.js';
import { JsonStore } from '../settings/jsonStore.js';

/**
 * Saved recipes (`<dataDir>/recipes.json`): a way of making a video that worked, kept so the next
 * one starts from it. They belong to the user, not to a video, so they live with Studio's settings.
 * Every save is kept as a new version and none is ever pruned (E39), so a recipe can always be
 * started from the way it was at any save. A recipe travels as a `.amrecipe.json` file.
 */

const fields = studioAiInputs.saveRecipe.omit({ id: true });
type RecipeFields = z.infer<typeof fields>;
const versionSchema = fields.extend({ version: z.number().int().min(1), savedAt: z.number() });
type RecipeVersion = z.infer<typeof versionSchema>;
const recipeSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  versions: z.array(versionSchema).min(1),
});
type StoredRecipe = z.infer<typeof recipeSchema>;

const fileV2 = z.object({ version: z.literal(2), recipes: z.record(z.string(), recipeSchema) });
type RecipeFile = z.infer<typeof fileV2>;

/** E32's file: one recipe, replaced on every save. Read as the first version of each. */
const fileV1 = z
  .object({
    version: z.literal(1),
    recipes: z.record(
      z.string(),
      fields.extend({ id: z.string(), createdAt: z.number(), updatedAt: z.number() }).passthrough(),
    ),
  })
  .transform(
    (old): RecipeFile => ({
      version: 2,
      recipes: Object.fromEntries(
        Object.values(old.recipes).map((r) => {
          const { id, createdAt, updatedAt, ...rest } = r;
          const kept = fields.parse(rest);
          return [id, { id, createdAt, versions: [{ ...kept, version: 1, savedAt: updatedAt }] }];
        }),
      ),
    }),
  );

const fileSchema = z.union([fileV2, fileV1]) as unknown as z.ZodType<RecipeFile>;

/** The file a recipe is exported as. */
const exportSchema = z.object({
  format: z.literal('agentmate-studio-recipe'),
  formatVersion: z.literal(1),
  recipe: z.object({ versions: z.array(versionSchema).min(1).max(1000) }),
});

function view(recipe: StoredRecipe, version: RecipeVersion): RecipeView {
  const { savedAt, version: n, ...rest } = version;
  return {
    ...rest,
    id: recipe.id,
    version: n,
    versions: recipe.versions.length,
    createdAt: recipe.createdAt,
    updatedAt: savedAt,
  };
}

const latest = (recipe: StoredRecipe) =>
  recipe.versions[recipe.versions.length - 1] as RecipeVersion;

export class RecipeStore {
  private readonly store: JsonStore<RecipeFile>;

  constructor(
    file: string,
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {
    this.store = new JsonStore(file, fileSchema, () => ({ version: 2, recipes: {} }), now);
  }

  /** Each recipe at its latest save, most recently changed first. */
  async list(): Promise<RecipeView[]> {
    const { recipes } = await this.store.read();
    return Object.values(recipes)
      .map((r) => view(r, latest(r)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Every save of a recipe, newest first. */
  async versions(recipeId: string): Promise<RecipeView[]> {
    const recipe = (await this.store.read()).recipes[recipeId];
    if (!recipe) throw new Error('That recipe is not saved any more.');
    return [...recipe.versions].reverse().map((v) => view(recipe, v));
  }

  async version(recipeId: string, version: number): Promise<RecipeView> {
    const recipe = (await this.store.read()).recipes[recipeId];
    const found = recipe?.versions.find((v) => v.version === version);
    if (!recipe || !found) throw new Error('That recipe version is not saved any more.');
    return view(recipe, found);
  }

  /** Saves a new recipe, or a new version of the one with `input.id`; earlier versions stay. */
  async save(input: SaveRecipeInput): Promise<RecipeView> {
    const at = this.now();
    let saved: RecipeView | undefined;
    await this.store.mutate((file) => {
      const { id, ...rest } = input;
      const old = id ? file.recipes[id] : undefined;
      if (id && !old) throw new Error('That recipe is not saved any more.');
      const recipe: StoredRecipe = old ?? { id: this.newId(), createdAt: at, versions: [] };
      const version: RecipeVersion = {
        ...(rest as RecipeFields),
        version: recipe.versions.length + 1,
        savedAt: at,
      };
      recipe.versions.push(version);
      file.recipes[recipe.id] = recipe;
      saved = view(recipe, version);
    });
    return saved as RecipeView;
  }

  /** The whole file, for the app's backup. */
  async backup(): Promise<RecipeFile> {
    return this.store.read();
  }

  /** Whether a backup's recipes can be restored; null when they can. */
  static checkBackup(value: unknown): string | null {
    return fileSchema.safeParse(value).success
      ? null
      : "The backup's Studio recipes could not be read.";
  }

  /** Puts back a backup's recipes in place of these. Check it first with `checkBackup`. */
  async restore(value: unknown): Promise<void> {
    const parsed = fileSchema.parse(value);
    await this.store.mutate(() => parsed);
  }

  async remove(id: string): Promise<void> {
    await this.store.mutate((file) => {
      delete file.recipes[id];
    });
  }

  /** The recipe, every version of it, as the text of a `.amrecipe.json` file. */
  async exportText(recipeId: string): Promise<{ name: string; text: string }> {
    const recipe = (await this.store.read()).recipes[recipeId];
    if (!recipe) throw new Error('That recipe is not saved any more.');
    const file: z.infer<typeof exportSchema> = {
      format: 'agentmate-studio-recipe',
      formatVersion: 1,
      recipe: { versions: recipe.versions },
    };
    return { name: latest(recipe).name, text: `${JSON.stringify(file, null, 2)}\n` };
  }

  /**
   * Adds a recipe from a `.amrecipe.json` file, with all its versions, as a new recipe. Its
   * contents are checked like a save: a language Studio does not offer, a style it does not have
   * or anything malformed refuses the whole file.
   */
  async importText(text: string): Promise<RecipeView> {
    let parsed: z.infer<typeof exportSchema>;
    try {
      parsed = exportSchema.parse(JSON.parse(text));
    } catch {
      throw new Error('That is not a Studio recipe file, or it is damaged.');
    }
    const at = this.now();
    const recipe: StoredRecipe = {
      id: this.newId(),
      createdAt: at,
      versions: parsed.recipe.versions
        .sort((a, b) => a.version - b.version)
        .map((v, k) => ({ ...v, version: k + 1 })),
    };
    await this.store.mutate((file) => {
      file.recipes[recipe.id] = recipe;
    });
    return view(recipe, latest(recipe));
  }
}
