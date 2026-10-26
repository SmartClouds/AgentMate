import { createScene, type RecipeView } from '@agentmat/studio';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { RecipesDialog } from '../home/RecipesDialog';
import { detail, generation } from '../testing/aiFixtures';
import { document, NOW } from '../testing/fixtures';
import { GenerationDetailsDialog } from './GenerationDetailsDialog';
import { SaveRecipeDialog } from './SaveRecipeDialog';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

beforeEach(() => {
  confirm.mockClear();
  confirm.mockResolvedValue(true);
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('GenerationDetailsDialog', () => {
  it('shows the CLI, model, effort and what was asked, and every attempt with its texts', async () => {
    const { user, bridge } = renderWithProviders(
      <GenerationDetailsDialog videoId="v1" generationId="g1" onOpenChange={vi.fn()} />,
      { bridge: { 'studioAi.generationDetail': async () => detail() } },
    );
    expect(await screen.findByText('Written')).toBeInTheDocument();
    expect(bridge.$fn('studioAi.generationDetail')).toHaveBeenCalledWith('v1', 'g1');
    expect(screen.getByText(/^Claude Code · /)).toBeInTheDocument();
    expect(screen.getByText('opus')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('یک ویدیو درباره‌ی صرفه‌جویی آب')).toBeInTheDocument();
    expect(screen.getByText('about 60 s')).toBeInTheDocument();

    const first = screen.getByRole('region', { name: 'First try' });
    expect(within(first).getByText('scenes[0].title: Too small')).toBeInTheDocument();
    await user.click(within(first).getByRole('button', { name: /Request sent/ }));
    expect(within(first).getByText('# Write a video scenario')).toBeInTheDocument();
    await user.click(within(first).getByRole('button', { name: /CLI output/ }));
    expect(within(first).getByText('Reading request.md')).toBeInTheDocument();

    const repair = screen.getByRole('region', { name: 'Repair round 1' });
    await user.click(within(repair).getByRole('button', { name: /Answer/ }));
    expect(within(repair).getByText('{"logline": "ok"}')).toBeInTheDocument();
    // The repair round printed no log, so there is nothing to open.
    expect(within(repair).queryByRole('button', { name: /CLI output/ })).not.toBeInTheDocument();
  });

  it('names the CLI that answered when the default was used, and shows a failure', async () => {
    renderWithProviders(
      <GenerationDetailsDialog videoId="v1" generationId="g1" onOpenChange={vi.fn()} />,
      {
        bridge: {
          'studioAi.generationDetail': async () =>
            detail({
              cliId: null,
              cliName: 'Codex',
              model: null,
              effort: null,
              status: 'failed',
              error: 'Codex timed out',
            }),
        },
      },
    );
    expect(await screen.findByText('Answered by')).toBeInTheDocument();
    expect(screen.getByText('CLI default')).toBeInTheDocument();
    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(screen.getByText('Codex timed out')).toBeInTheDocument();
  });

  it('offers to load it again when the record did not load', async () => {
    renderWithProviders(
      <GenerationDetailsDialog videoId="v1" generationId="g1" onOpenChange={vi.fn()} />,
      {
        bridge: {
          'studioAi.generationDetail': async () => {
            throw new Error('gone');
          },
        },
      },
    );
    expect(await screen.findByText(/did not load/)).toBeInTheDocument();
  });

  it('stays closed without a run', () => {
    renderWithProviders(
      <GenerationDetailsDialog videoId="v1" generationId={null} onOpenChange={vi.fn()} />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('SaveRecipeDialog', () => {
  it('saves the brief, look, format, length and AI of a scenario run', async () => {
    const onOpenChange = vi.fn();
    const g = generation({ status: 'done' });
    const doc = document({ title: 'Water film' });
    doc.renderSettings.aspect = '9:16';
    doc.scenario.scenes = [
      createScene({ id: 's1', voiceRef: 'recording' }),
      createScene({ id: 's2', voiceRef: 'azure:fa-IR-DilaraNeural' }),
    ];
    const { user, bridge } = renderWithProviders(
      <SaveRecipeDialog generation={g} document={doc} onOpenChange={onOpenChange} />,
      {
        bridge: {
          'studioAi.saveRecipe': async (input: object) => ({ id: 'r1', version: 1, ...input }),
          'studioAi.recipes': async () => [],
        },
      },
    );
    const name = screen.getByLabelText('Recipe name');
    expect(name).toHaveValue('Water film');
    await user.clear(name);
    await user.type(name, 'Explainer');
    await user.click(screen.getByRole('button', { name: 'Save recipe' }));
    await waitFor(() =>
      expect(bridge.$fn('studioAi.saveRecipe')).toHaveBeenCalledWith({
        name: 'Explainer',
        brief: g.instruction,
        styleId: 'flat-vector',
        language: 'fa',
        aspect: '9:16',
        targetSeconds: 60,
        scenario: { cliId: 'claude-code', model: 'opus', effort: 'high' },
        stages: {},
        voiceRef: 'azure:fa-IR-DilaraNeural',
        render: { resolution: '1080p', fps: 30, quality: 'standard', codec: 'h264' },
      }),
    );
    expect(toast.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows why a save failed', async () => {
    const { user } = renderWithProviders(
      <SaveRecipeDialog
        generation={generation({ status: 'done' })}
        document={document()}
        onOpenChange={vi.fn()}
      />,
      {
        bridge: {
          'studioAi.saveRecipe': async () => {
            throw new Error(
              "Error invoking remote method 'studioAi:saveRecipe': Error: Disk full.",
            );
          },
        },
      },
    );
    await user.click(screen.getByRole('button', { name: 'Save recipe' }));
    expect(await screen.findByText('Disk full.')).toBeInTheDocument();
  });
});

describe('RecipesDialog', () => {
  const recipe: RecipeView = {
    id: 'r1',
    name: 'Explainer',
    brief: 'Explain the product',
    styleId: 'bauhaus',
    language: 'en',
    aspect: '1:1',
    targetSeconds: 45,
    scenario: { cliId: 'claude-code', model: null, effort: null },
    version: 1,
    versions: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('lists the recipes, starts a video from one and deletes one after asking', async () => {
    const onUse = vi.fn();
    const { user, bridge } = renderWithProviders(
      <RecipesDialog open onOpenChange={vi.fn()} onUse={onUse} />,
      {
        bridge: {
          'studioAi.recipes': async () => [recipe],
          'studioAi.deleteRecipe': async () => undefined,
        },
      },
    );
    expect(await screen.findByText('Explainer')).toBeInTheDocument();
    expect(screen.getByText(/Square 1:1 · 45 s · Bauhaus · Claude Code/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use' }));
    expect(onUse).toHaveBeenCalledWith('r1');
    await user.click(screen.getByRole('button', { name: 'Delete Explainer' }));
    expect(confirm).toHaveBeenCalled();
    expect(bridge.$fn('studioAi.deleteRecipe')).toHaveBeenCalledWith('r1');
  });

  it('keeps a recipe the user chose not to delete, and explains an empty list', async () => {
    confirm.mockResolvedValue(false);
    const { user, bridge } = renderWithProviders(
      <RecipesDialog open onOpenChange={vi.fn()} onUse={vi.fn()} />,
      { bridge: { 'studioAi.recipes': async () => [recipe] } },
    );
    await user.click(await screen.findByRole('button', { name: 'Delete Explainer' }));
    expect(bridge.$fn('studioAi.recipes')).toHaveBeenCalled();
    expect(screen.getByText('Explainer')).toBeInTheDocument();
  });

  it('lists a recipe versions, starts from an earlier one, and exports and imports (E39)', async () => {
    const onUse = vi.fn();
    const v2 = { ...recipe, version: 2, versions: 2, targetSeconds: 60 };
    const { user, bridge } = renderWithProviders(
      <RecipesDialog open onOpenChange={vi.fn()} onUse={onUse} />,
      {
        bridge: {
          'studioAi.recipes': async () => [v2],
          'studioAi.recipeVersions': async () => [v2, recipe],
          'studioAi.exportRecipe': async () => 'D:\recipes\Explainer.amrecipe.json',
          'studioAi.importRecipe': async () => ({
            ...recipe,
            id: 'r9',
            name: 'Shared',
            versions: 3,
          }),
        },
      },
    );
    const row = await screen.findByRole('listitem', { name: 'Explainer' });
    expect(within(row).getByText('Version 2')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Versions' }));
    const list = await screen.findByRole('list', { name: 'Versions of Explainer' });
    expect(list.textContent).toMatch(/Version 1, saved .*: 45 s, Claude Code/);
    await user.click(within(list).getByRole('button', { name: 'Use version 1' }));
    expect(onUse).toHaveBeenCalledWith('r1', 1);
    await user.click(within(row).getByRole('button', { name: 'Export' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Saved the recipe to D:\recipes\Explainer.amrecipe.json.',
      ),
    );
    expect(bridge.$fn('studioAi.exportRecipe')).toHaveBeenCalledWith('r1');
    await user.click(screen.getByRole('button', { name: 'Import a recipe file' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Added "Shared" with its 3 saved versions.'),
    );
  });

  it('says there are none yet', async () => {
    renderWithProviders(<RecipesDialog open onOpenChange={vi.fn()} onUse={vi.fn()} />, {
      bridge: { 'studioAi.recipes': async () => [] },
    });
    expect(await screen.findByText('No recipes yet')).toBeInTheDocument();
  });
});
