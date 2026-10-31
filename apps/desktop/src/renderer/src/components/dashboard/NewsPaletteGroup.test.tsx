import { DEFAULT_SETTINGS } from '@shared/defaultSettings';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Command } from 'cmdk';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { NewsPaletteGroup } from './NewsPaletteGroup';

/**
 * The news commands in the command palette (E42): Open news shows the Dashboard with the full
 * list, Refresh news asks main to check now. Neither is offered while news is off in Settings.
 */

let location = '';

function LocationProbe(): null {
  const current = useLocation();
  location = `${current.pathname}${current.search}`;
  return null;
}

function renderGroup(settings: Record<string, unknown> = {}) {
  const onDone = vi.fn();
  const rendered = renderWithProviders(
    <>
      <Command>
        <Command.List>
          <NewsPaletteGroup onDone={onDone} />
        </Command.List>
      </Command>
      <LocationProbe />
    </>,
    {
      route: '/projects',
      bridge: {
        'settings.get': { ...DEFAULT_SETTINGS, ...settings },
        'news.refresh': async () => ({
          items: [],
          page: 1,
          totalPages: 1,
          total: 0,
          stale: false,
          checkedAt: null,
        }),
      },
    },
  );
  return { ...rendered, onDone };
}

describe('NewsPaletteGroup', () => {
  it('opens the Dashboard with every news item listed', async () => {
    const { onDone } = renderGroup();
    fireEvent.click(await screen.findByRole('option', { name: 'Open news' }));
    expect(onDone).toHaveBeenCalled();
    expect(location).toBe('/?newsAll=1');
  });

  it('asks main to check for news now', async () => {
    const { bridge, onDone } = renderGroup();
    fireEvent.click(await screen.findByRole('option', { name: 'Refresh news' }));
    expect(onDone).toHaveBeenCalled();
    await waitFor(() => expect(bridge.$fn('news.refresh')).toHaveBeenCalled());
  });

  it('offers nothing while news is off', async () => {
    const { bridge, container } = renderGroup({ newsEnabled: false });
    await waitFor(() => expect(bridge.$fn('settings.get')).toHaveBeenCalled());
    expect(container.querySelector('[cmdk-group]')).toBeNull();
  });
});
