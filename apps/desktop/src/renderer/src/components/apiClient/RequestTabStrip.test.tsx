import { emptyDraft } from '@runova/core';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiTab } from '@/stores/apiClientTabsStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RequestTabStrip } from './RequestTabStrip';

const tab = (id: string, name: string, method = 'GET', dirty = false): ApiTab => {
  const draft = { ...emptyDraft(), method };
  return {
    id,
    name,
    source: null,
    original: null,
    draft,
    savedSignature: dirty ? 'something else' : '',
    run: { status: 'idle' },
  };
};

function setup() {
  const handlers = { onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn() };
  const tabs = [tab('a', 'List users'), tab('b', 'Create user', 'POST', true)];
  const view = renderWithProviders(
    <RequestTabStrip tabs={tabs} activeTabId="a" isDirty={(t) => t.id === 'b'} {...handlers} />,
  );
  return { ...view, ...handlers };
}

describe('RequestTabStrip', () => {
  it('shows each tab with its method and marks the active one', () => {
    setup();
    const active = screen.getByRole('tab', { name: /GET List users/ });
    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /POST Create user/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('marks a tab with unsaved changes', () => {
    setup();
    expect(screen.getByRole('tab', { name: /Create user.*unsaved/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /List users.*unsaved/i })).not.toBeInTheDocument();
  });

  it('selects, closes and opens tabs', async () => {
    const { user, onSelect, onClose, onNew } = setup();
    await user.click(screen.getByRole('tab', { name: /Create user/ }));
    expect(onSelect).toHaveBeenCalledWith('b');

    await user.click(screen.getByRole('button', { name: 'Close List users' }));
    expect(onClose).toHaveBeenCalledWith('a');
    expect(onSelect).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'New request tab' }));
    expect(onNew).toHaveBeenCalled();
  });

  it('closes a tab on middle click', () => {
    const { onClose } = setup();
    fireEvent(
      screen.getByRole('tab', { name: /Create user/ }),
      new MouseEvent('auxclick', { bubbles: true, button: 1 }),
    );
    expect(onClose).toHaveBeenCalledWith('b');
  });
});
