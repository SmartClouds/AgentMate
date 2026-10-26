import type { RecipeView } from '@runova/studio';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { usePendingRecipe, usePendingScenario } from '../ai/runSettings';
import { INSIDE_PROJECT, NOW, ok, PROJECT, settings, storage, video } from '../testing/fixtures';
import { NewVideoDialog } from './NewVideoDialog';

const RECIPE: RecipeView = {
  id: 'r1',
  name: 'Product explainer',
  brief: 'یک ویدیوی توضیحی برای محصول',
  styleId: 'flat-vector',
  language: 'fa',
  aspect: '9:16',
  targetSeconds: 30,
  scenario: { cliId: 'claude-code', model: 'opus', effort: 'high' },
  version: 1,
  versions: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

function renderDialog(
  projectId: string | null = null,
  overrides: Record<string, unknown> = {},
  recipeId: string | null = null,
) {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <NewVideoDialog
      open
      onOpenChange={onOpenChange}
      projectId={projectId}
      recipeId={recipeId}
      onCreated={onCreated}
    />,
    {
      bridge: {
        'projects.list': async () => [
          PROJECT,
          { ...PROJECT, id: 'p2', name: 'Old', archived: true },
        ],
        'studio.settings': async () => settings(),
        'studio.projectStorage': async () => storage(),
        'studio.create': async () => video(),
        'studioAi.recipes': async () => [],
        ...overrides,
      },
    },
  );
  return { ...view, onCreated, onOpenChange };
}

beforeEach(() => {
  usePendingScenario.setState({ pending: null });
  window.localStorage.clear();
});

describe('NewVideoDialog', () => {
  it('creates a Persian video and hands the brief to the editor to write the scenario', async () => {
    const { user, bridge, onCreated, onOpenChange } = renderDialog();
    expect(await screen.findByText(settings().standaloneRoot)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and write' })).toBeDisabled();
    await user.type(screen.getByLabelText('What is the video about?'), 'معرفی محصول تازه');
    await user.click(screen.getByRole('radio', { name: '30 s' }));
    await user.click(screen.getByRole('radio', { name: 'Vertical 9:16' }));
    await user.click(screen.getByRole('button', { name: 'Create and write' }));
    await waitFor(() =>
      expect(bridge.$fn('studio.create')).toHaveBeenCalledWith({
        title: 'Untitled video',
        projectId: null,
        language: 'fa',
        aspect: '9:16',
      }),
    );
    expect(onCreated).toHaveBeenCalledWith(video());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(usePendingScenario.getState().pending).toEqual({
      videoId: video().id,
      request: {
        brief: 'معرفی محصول تازه',
        targetSeconds: 30,
        styleId: null,
        run: { cliId: null, model: null, effort: null },
      },
    });
  });

  it('makes a blank video without AI, which then needs a title', async () => {
    const { user, bridge } = renderDialog();
    await user.click(await screen.findByRole('switch', { name: 'Write the scenario with AI' }));
    expect(screen.queryByLabelText('What is the video about?')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create video' })).toBeDisabled();
    await user.type(screen.getByLabelText('Title'), 'Teaser');
    await user.click(screen.getByRole('button', { name: 'Create video' }));
    await waitFor(() =>
      expect(bridge.$fn('studio.create')).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Teaser' }),
      ),
    );
    expect(usePendingScenario.getState().pending).toBeNull();
  });

  it('starts from a saved recipe, with its brief, look, format and AI', async () => {
    const { user, bridge } = renderDialog(null, { 'studioAi.recipes': async () => [RECIPE] });
    await user.click(await screen.findByRole('combobox', { name: 'Start from' }));
    await user.click(await screen.findByRole('option', { name: 'Product explainer' }));
    expect(screen.getByLabelText('What is the video about?')).toHaveValue(RECIPE.brief);
    expect(screen.getByRole('radio', { name: 'Vertical 9:16' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: '30 s' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: 'Create and write' }));
    await waitFor(() => expect(bridge.$fn('studio.create')).toHaveBeenCalled());
    expect(usePendingScenario.getState().pending?.request).toEqual({
      brief: RECIPE.brief,
      targetSeconds: 30,
      styleId: 'flat-vector',
      run: RECIPE.scenario,
    });
  });

  it('opens on a recipe picked from the Recipes list', async () => {
    renderDialog(null, { 'studioAi.recipes': async () => [RECIPE] }, 'r1');
    await waitFor(() =>
      expect(screen.getByLabelText('What is the video about?')).toHaveValue(RECIPE.brief),
    );
  });

  it('starts from an earlier version of a recipe with every stage choice it kept (E39 AC1)', async () => {
    const older: RecipeView = {
      ...RECIPE,
      version: 1,
      versions: 2,
      brief: 'The first brief',
      stages: {
        edit: { cliId: 'codex', model: 'gpt-6-luna', effort: 'medium' },
        scene: { cliId: 'gemini', model: null, effort: null },
      },
      voiceRef: 'azure:fa-IR-FaridNeural',
      render: { resolution: '720p', fps: 24, quality: 'high', codec: 'h265' },
    };
    const { user } = renderWithProviders(
      <NewVideoDialog
        open
        onOpenChange={vi.fn()}
        recipeId="r1"
        recipeVersion={1}
        onCreated={vi.fn()}
      />,
      {
        bridge: {
          'projects.list': async () => [PROJECT],
          'studio.settings': async () => settings(),
          'studio.projectStorage': async () => storage(),
          'studio.create': async () => video(),
          'studioAi.recipes': async () => [{ ...RECIPE, version: 2, versions: 2 }],
          'studioAi.recipeVersion': async () => older,
        },
      },
    );
    await waitFor(() =>
      expect(screen.getByLabelText('What is the video about?')).toHaveValue('The first brief'),
    );
    await user.click(screen.getByRole('button', { name: 'Create and write' }));
    await waitFor(() =>
      expect(usePendingScenario.getState().pending?.request.brief).toBe('The first brief'),
    );
    expect(usePendingRecipe.getState().pending?.recipe).toEqual({
      name: RECIPE.name,
      render: older.render,
      voiceRef: 'azure:fa-IR-FaridNeural',
    });
    const runs = JSON.parse(window.localStorage.getItem('studio.runSettings') ?? '{}');
    expect(runs.edit).toEqual({ cliId: 'codex', model: 'gpt-6-luna', effort: 'medium' });
    expect(runs.scene).toEqual({ cliId: 'gemini', model: undefined, effort: undefined });
  });

  it("uses the project's folder when opened from a project", async () => {
    const { user, bridge } = renderDialog('p1');
    expect(await screen.findByText(storage().root)).toBeInTheDocument();
    await user.type(screen.getByLabelText('What is the video about?'), 'Teaser');
    await user.click(screen.getByRole('button', { name: 'Create and write' }));
    await waitFor(() =>
      expect(bridge.$fn('studio.create')).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1' }),
      ),
    );
  });

  it('will not create a project video while its folder is not allowed, and says why', async () => {
    const { user } = renderDialog('p1', {
      'studio.projectStorage': async () => storage({ check: ok([INSIDE_PROJECT]) }),
    });
    expect(await screen.findByText(/inside the project's folder/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('What is the video about?'), 'Teaser');
    expect(screen.getByRole('button', { name: 'Create and write' })).toBeDisabled();
  });

  it('shows what went wrong when the video could not be made', async () => {
    const { user } = renderDialog(null, {
      'studio.create': async () => {
        throw new Error("Error invoking remote method 'studio:create': Error: The disk is full.");
      },
    });
    await user.type(await screen.findByLabelText('What is the video about?'), 'Film');
    await user.click(screen.getByRole('button', { name: 'Create and write' }));
    expect(await screen.findByText('The disk is full.')).toBeInTheDocument();
    expect(usePendingScenario.getState().pending).toBeNull();
  });

  it('offers no Chinese among the languages', async () => {
    const { user } = renderDialog();
    await user.click(await screen.findByRole('combobox', { name: 'Language' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toContain('Persian (فارسی)');
    expect(options.some((o) => /chinese/i.test(o.textContent ?? ''))).toBe(false);
  });
});
