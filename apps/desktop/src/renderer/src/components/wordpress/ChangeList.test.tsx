import type { WpPlannedChange } from '@runova/core';
import { screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { change } from '../projects/wordpress/testing/fixtures';
import { IgnoreSelectionBar } from './IgnoreSelectionBar';

vi.mock('@/components/editor/MonacoDiffEditor', async () => ({
  MonacoDiffEditor: (await import('../deploy/sites/testing/monacoMocks')).FakeMonacoDiffEditor,
}));

const { ChangeList, changeKey } = await import('./ChangeList');

/**
 * The files a deploy would change. With the ignore props on, each row can be ticked and has a
 * menu to leave out the file, a folder above it, or every file with the same ending.
 */

const SOLO = { kind: 'plugin', slug: 'solo.php' } as const;

const CHANGES: WpPlannedChange[] = [
  change({ path: 'style.css' }),
  change({ path: 'assets/css/app.css.map', local: 'added', expectedRemote: null }),
  change({ path: 'vendor/lib/a.php', local: 'added', expectedRemote: null }),
  change({ item: { kind: 'plugin', slug: 'woocommerce' }, path: 'readme.txt' }),
];

function renderList(props: Partial<React.ComponentProps<typeof ChangeList>> = {}) {
  const onSelect = vi.fn();
  const onPickedChange = vi.fn();
  const onIgnore = vi.fn();
  const view = renderWithProviders(
    <ChangeList
      changes={CHANGES}
      direction="deploy"
      onSelect={onSelect}
      ignore={{ picked: new Set(), onPickedChange, onIgnore }}
      {...props}
    />,
  );
  return { ...view, onSelect, onPickedChange, onIgnore };
}

describe('ChangeList without the ignore props', () => {
  it('stays a plain list of buttons', () => {
    renderWithProviders(<ChangeList changes={CHANGES} direction="deploy" />);
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.queryByRole('button', { name: /Ignore options/ })).toBeNull();
    expect(screen.getByRole('button', { name: /style\.css/ })).toBeTruthy();
  });
});

/** Holds the ticks the way the deploy dialog does, so a click shows in the boxes. */
function Harness({
  initial = [],
  onIgnore = vi.fn(),
  disabled,
}: {
  initial?: string[];
  onIgnore?: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  const [picked, setPicked] = useState<Set<string>>(new Set(initial));
  return (
    <ChangeList
      changes={CHANGES}
      direction="deploy"
      ignore={{ picked, onPickedChange: setPicked, onIgnore, disabled }}
    />
  );
}

const state = (name: string) => screen.getByRole('checkbox', { name }).getAttribute('data-state');

describe('ChangeList with the ignore props', () => {
  it('ticks a file without opening its diff, and opens the diff from the name', async () => {
    const { user, onSelect, onPickedChange } = renderList();
    await user.click(screen.getByRole('checkbox', { name: 'Select style.css' }));
    expect(onPickedChange).toHaveBeenCalledWith(new Set([changeKey(CHANGES[0])]));
    expect(onSelect).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^Modified\s*style\.css/ }));
    expect(onSelect).toHaveBeenCalledWith(CHANGES[0]);
  });

  it('unticks a ticked file and keeps the others', async () => {
    const { user } = renderWithProviders(
      <Harness initial={[changeKey(CHANGES[0]), changeKey(CHANGES[1])]} />,
    );
    expect(state('Select style.css')).toBe('checked');
    await user.click(screen.getByRole('checkbox', { name: 'Select style.css' }));
    expect(state('Select style.css')).toBe('unchecked');
    expect(state('Select assets/css/app.css.map')).toBe('checked');
  });

  it('selects every file of one theme or plugin from its heading, with a mixed state in between', async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole('checkbox', { name: 'Select all changes in storefront' }));
    expect(state('Select all changes in storefront')).toBe('checked');
    expect(state('Select style.css')).toBe('checked');
    expect(state('Select vendor/lib/a.php')).toBe('checked');
    expect(state('Select readme.txt')).toBe('unchecked');
    expect(state('Select all changes in woocommerce')).toBe('unchecked');

    await user.click(screen.getByRole('checkbox', { name: 'Select vendor/lib/a.php' }));
    expect(state('Select all changes in storefront')).toBe('indeterminate');
  });

  it('clears one heading when all its files are ticked and it is clicked again', async () => {
    const { user } = renderWithProviders(<Harness initial={CHANGES.slice(0, 3).map(changeKey)} />);
    expect(state('Select all changes in storefront')).toBe('checked');
    await user.click(screen.getByRole('checkbox', { name: 'Select all changes in storefront' }));
    expect(state('Select all changes in storefront')).toBe('unchecked');
    expect(state('Select style.css')).toBe('unchecked');
  });

  it('offers to ignore the file, the folders above it and the ending, from the row menu', async () => {
    const { user, onIgnore } = renderList();
    await user.click(
      screen.getByRole('button', { name: 'Ignore options for assets/css/app.css.map' }),
    );
    const menu = await screen.findByRole('menu');
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(labels).toEqual([
      'Ignore this file',
      'Ignore the folder assets/',
      'Ignore the folder assets/css/',
      'Ignore every .map file in this theme',
      'Ignore every .map file in every theme and plugin',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Ignore the folder assets/' }));
    expect(onIgnore).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'theme:storefront', pattern: '/assets/' }),
    );
  });

  it('has no menu for the only file of a single-file plugin', () => {
    renderList({ changes: [change({ item: SOLO, path: 'solo.php' })] });
    expect(screen.queryByRole('button', { name: /Ignore options/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Select solo.php' })).toBeTruthy();
  });

  it('locks the ticks and the menus while the list is being updated', () => {
    renderWithProviders(<Harness disabled />);
    expect(
      (screen.getByRole('checkbox', { name: 'Select style.css' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Ignore options for style.css' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Select all changes in storefront',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe('IgnoreSelectionBar', () => {
  it('counts the ticked files and offers to ignore or clear them', async () => {
    const onIgnore = vi.fn();
    const onClear = vi.fn();
    const { user } = renderWithProviders(
      <IgnoreSelectionBar count={3} onIgnore={onIgnore} onClear={onClear} />,
    );
    expect(screen.getByText('3 files selected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ignore selected files' }));
    expect(onIgnore).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('says one file in the singular, and holds the buttons while busy', () => {
    renderWithProviders(<IgnoreSelectionBar count={1} busy onIgnore={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByText('1 file selected')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Ignore selected files' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows nothing when no file is ticked', () => {
    const { container } = renderWithProviders(
      <IgnoreSelectionBar count={0} onIgnore={vi.fn()} onClear={vi.fn()} />,
    );
    expect(container.textContent).toBe('');
  });
});
