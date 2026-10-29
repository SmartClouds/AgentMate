import { act } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderHookWithProviders } from '../../../../test/renderer/renderWithProviders';
import { useTabParam } from './useTabParam';

/**
 * A section's tabs live in the page's address (`&tab=`), so the page remembers them along with the
 * section and they come back when Deploy is opened again.
 */

const TABS = ['containers', 'images', 'volumes'] as const;

function render(route: string) {
  return renderHookWithProviders(
    () => {
      const [tab, setTab] = useTabParam(TABS, 'containers');
      const location = useLocation();
      return { tab, setTab, search: location.search };
    },
    { route },
  );
}

describe('useTabParam', () => {
  it('reads the tab from the address', () => {
    expect(render('/deploy?server=srv-1&view=containers&tab=images').result.current.tab).toBe(
      'images',
    );
  });

  it('falls back to the first tab when the address names none, or one it does not know', () => {
    expect(render('/deploy?server=srv-1&view=containers').result.current.tab).toBe('containers');
    expect(render('/deploy?server=srv-1&tab=bogus').result.current.tab).toBe('containers');
  });

  it('writes the tab next to what the address already says', () => {
    const { result } = render('/deploy?server=srv-1&view=containers');
    act(() => result.current.setTab('volumes'));
    expect(result.current.tab).toBe('volumes');
    expect(result.current.search).toBe('?server=srv-1&view=containers&tab=volumes');
  });

  it('leaves the first tab out of the address', () => {
    const { result } = render('/deploy?server=srv-1&view=containers&tab=images');
    act(() => result.current.setTab('containers'));
    expect(result.current.search).toBe('?server=srv-1&view=containers');
  });
});
