// @vitest-environment jsdom
import type { VaultCategory } from '@runova/core';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VaultCategoryFilter } from '@/lib/vault/categories';
import {
  category,
  expectNoNativeTitles,
  installDomShims,
  renderWithVaultProviders,
} from './testing/mockVaultApi';
import { VAULT_ENTRY_DRAG_TYPE } from './VaultEntryRow';

installDomShims();

const { VaultCategoryRail } = await import('./VaultCategoryRail');

const work = category({ id: 'work', name: 'Work', color: 'blue', icon: 'briefcase' });
const bank = category({ id: 'bank', name: 'Banking', color: 'green', icon: 'bank' });

function renderRail(
  options: {
    categories?: VaultCategory[];
    active?: VaultCategoryFilter;
    variant?: 'rail' | 'strip';
  } = {},
) {
  const props = {
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
    onDropEntries: vi.fn(),
  };
  const categories = options.categories ?? [work, bank];
  renderWithVaultProviders(
    <VaultCategoryRail
      variant={options.variant ?? 'rail'}
      categories={categories}
      counts={{
        all: 5,
        uncategorized: 1,
        byId: new Map([
          ['work', 3],
          ['bank', 1],
        ]),
      }}
      active={options.active ?? 'all'}
      {...props}
    />,
  );
  return props;
}

function dragOf(id: string | null) {
  const data = new Map(id ? [[VAULT_ENTRY_DRAG_TYPE, id]] : [['text/plain', 'hello']]);
  return {
    dataTransfer: {
      types: [...data.keys()],
      getData: (type: string) => data.get(type) ?? '',
      dropEffect: 'none',
    },
  };
}

afterEach(() => {
  expectNoNativeTitles();
  cleanup();
});

describe('VaultCategoryRail', () => {
  it('lists every category with its count, between all items and uncategorized', () => {
    renderRail();
    const nav = screen.getByRole('navigation', { name: 'Categories' });
    const names = within(nav)
      .getAllByRole('button', { name: /\(\d+\)$/ })
      .map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['All items (5)', 'Work (3)', 'Banking (1)', 'Uncategorized (1)']);
  });

  it('marks the active filter and switches when another is picked', () => {
    const props = renderRail({ active: 'work' });
    expect(screen.getByRole('button', { name: 'Work (3)' }).getAttribute('aria-current')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'All items (5)' }).hasAttribute('aria-current')).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Banking (1)' }));
    expect(props.onSelect).toHaveBeenCalledWith('bank');
    fireEvent.click(screen.getByRole('button', { name: 'Uncategorized (1)' }));
    expect(props.onSelect).toHaveBeenCalledWith('uncategorized');
  });

  it('edits, reorders and deletes a category from its menu', async () => {
    const user = userEvent.setup();
    const props = renderRail();

    await user.click(screen.getByRole('button', { name: 'Options for Work' }));
    expect(screen.getByRole('menuitem', { name: 'Move up' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Move down' }));
    expect(props.onReorder).toHaveBeenCalledWith(['bank', 'work']);

    await user.click(screen.getByRole('button', { name: 'Options for Banking' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(props.onEdit).toHaveBeenCalledWith(bank);

    await user.click(screen.getByRole('button', { name: 'Options for Banking' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(props.onDelete).toHaveBeenCalledWith(bank);
  });

  it('files an entry dropped onto a category, or onto uncategorized', () => {
    const props = renderRail();
    const target = screen.getByRole('button', { name: 'Banking (1)' });
    fireEvent.dragEnter(target, dragOf('gh'));
    fireEvent.dragOver(target, dragOf('gh'));
    expect(target.getAttribute('data-drop-target')).toBe('true');
    fireEvent.drop(target, dragOf('gh'));
    expect(props.onDropEntries).toHaveBeenCalledWith(['gh'], 'bank');
    expect(target.hasAttribute('data-drop-target')).toBe(false);

    fireEvent.drop(screen.getByRole('button', { name: 'Uncategorized (1)' }), dragOf('gh'));
    expect(props.onDropEntries).toHaveBeenLastCalledWith(['gh'], null);
  });

  it('ignores drags that are not vault entries, and drops on all items', () => {
    const props = renderRail();
    fireEvent.drop(screen.getByRole('button', { name: 'Work (3)' }), dragOf(null));
    fireEvent.drop(screen.getByRole('button', { name: 'All items (5)' }), dragOf('gh'));
    expect(props.onDropEntries).not.toHaveBeenCalled();
  });

  it('invites making a first category when there are none', () => {
    const props = renderRail({ categories: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Create your first category' }));
    expect(props.onNew).toHaveBeenCalledTimes(1);
  });

  it('adds a category from the header button', () => {
    const props = renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'New category' }));
    expect(props.onNew).toHaveBeenCalledTimes(1);
  });

  it('shows the same filters as a strip of pills on narrow windows', () => {
    const props = renderRail({ variant: 'strip', active: 'bank' });
    const nav = screen.getByRole('navigation', { name: 'Categories' });
    expect(
      within(nav).getByRole('button', { name: 'Banking (1)' }).getAttribute('aria-current'),
    ).toBe('true');
    fireEvent.click(within(nav).getByRole('button', { name: 'Work (3)' }));
    expect(props.onSelect).toHaveBeenCalledWith('work');
    fireEvent.click(within(nav).getByRole('button', { name: 'New category' }));
    expect(props.onNew).toHaveBeenCalled();
  });
});
