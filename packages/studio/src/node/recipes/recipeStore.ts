import { z } from 'zod';
import { type RecipeView, runSettingsSchema, type SaveRecipeInput } from '../../api.js';
import { ASPECTS } from '../../document/schema.js';
import { JsonStore } from '../settings/jsonStore.js';

/**
 * Saved recipes (`<dataDir>/recipes.json`): a way of making a video that worked, kept so the next
 * one starts from it. They belong to the user, not to a video, so they live with Studio's settings.
 */

const recipeSchema = z.object({
  id: z.string(),
  name: z.string(),
  brief: z.string(),
  styleId: z.string().nullable(),
  language: z.string(),
  aspect: z.enum(ASPECTS),
  targetSeconds: z.number(),
  scenario: runSettingsSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

const fileSchema = z.object({ version: z.literal(1), recipes: z.record(z.string(), recipeSchema) });
type RecipeFile = z.infer<typeof fileSchema>;

export class RecipeStore {
  private readonly store: JsonStore<RecipeFile>;

  constructor(
    file: string,
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {
    this.store = new JsonStore(file, fileSchema, () => ({ version: 1, recipes: {} }), now);
  }

  /** Most recently changed first. */
  async list(): Promise<RecipeView[]> {
    const { recipes } = await this.store.read();
    return Object.values(recipes).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Saves a new recipe, or replaces the one with `input.id`. */
  async save(input: SaveRecipeInput): Promise<RecipeView> {
    const at = this.now();
    let saved: RecipeView | undefined;
    await this.store.mutate((file) => {
      const old = input.id ? file.recipes[input.id] : undefined;
      if (input.id && !old) throw new Error('That recipe is not saved any more.');
      const { id: _id, ...fields } = input;
      saved = {
        ...fields,
        id: old?.id ?? this.newId(),
        createdAt: old?.createdAt ?? at,
        updatedAt: at,
      };
      file.recipes[saved.id] = saved;
    });
    return saved as RecipeView;
  }

  async remove(id: string): Promise<void> {
    await this.store.mutate((file) => {
      delete file.recipes[id];
    });
  }
}
