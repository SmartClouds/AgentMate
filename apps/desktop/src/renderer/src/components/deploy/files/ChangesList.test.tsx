import type { FilesLeftOut, FilesPendingFile } from '@shared/deployFilesTypes';
import { fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ChangesList } from './ChangesList';
import { pending, snapshot } from './testing/fixtures';

/**
 * The live list of what changed in the deploy folder: grouped by folder, filtered by kind or a
 * search, each file ticked to go or not, and the files left out with the reason for each.
 */

const FILES = [
  pending('index.html', 'modified', 2048),
  pending('css/site.css', 'added', 4096),
  pending('css/print.css', 'deleted', 512),
  pending('img/logo.png', 'added', 1536),
];

function Harness({
  files = FILES,
  leftOut = [],
  onChange,
  disabled,
}: {
  files?: FilesPendingFile[];
  leftOut?: FilesLeftOut[];
  onChange?: (deselected: Set<string>) => void;
  disabled?: boolean;
}) {
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  return (
    <ChangesList
      snapshot={snapshot({ files, leftOut })}
      deselected={deselected}
      onDeselectedChange={(next) => {
        setDeselected(next);
        onChange?.(next);
      }}
      disabled={disabled}
    />
  );
}

function list(): HTMLElement {
  return screen.getByRole('list', { name: 'Changed files' });
}

describe('ChangesList', () => {
  it('groups the files by folder and says what happened to each, in words', () => {
    renderWithProviders(<Harness />);

    const folders = within(list()).getAllByRole('button', { name: /^(Collapse|Expand)/ });
    expect(folders.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Collapse Top folder',
      'Collapse css',
      'Collapse img',
    ]);
    const deleted = screen.getByText('css/print.css');
    expect(deleted.className).toContain('line-through');
    const row = deleted.closest('li') as HTMLElement;
    expect(within(row).getByText('Deleted')).toBeTruthy();
    expect(
      within(screen.getByText('css/site.css').closest('li') as HTMLElement).getByText('Added'),
    ).toBeTruthy();
    expect(
      within(screen.getByText('index.html').closest('li') as HTMLElement).getByText('2.00 KB'),
    ).toBeTruthy();
  });

  it('filters by kind, with a count on each chip', async () => {
    const { user } = renderWithProviders(
      <Harness leftOut={[{ path: '.env', reason: 'hardDenied' }]} />,
    );

    const filters = screen.getByRole('group', { name: 'Show' });
    expect(
      within(filters).getByRole('button', { name: /All 4/ }).getAttribute('aria-pressed'),
    ).toBe('true');
    await user.click(within(filters).getByRole('button', { name: /Added 2/ }));
    expect(screen.getByText('css/site.css')).toBeTruthy();
    expect(screen.queryByText('index.html')).toBeNull();
    await user.click(within(filters).getByRole('button', { name: /Deleted 1/ }));
    expect(screen.getByText('css/print.css')).toBeTruthy();
    expect(screen.queryByText('css/site.css')).toBeNull();
    expect(within(filters).getByRole('button', { name: /Modified 1/ })).toBeTruthy();
  });

  it('searches the paths, and says so when nothing matches', async () => {
    const { user } = renderWithProviders(<Harness />);

    await user.type(screen.getByRole('searchbox', { name: 'Search the changes' }), 'logo');
    expect(screen.getByText('img/logo.png')).toBeTruthy();
    expect(screen.queryByText('index.html')).toBeNull();

    await user.clear(screen.getByRole('searchbox', { name: 'Search the changes' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search the changes' }), 'nothing');
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });

  it('unticks one file, a whole folder, or everything shown', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('checkbox', { name: 'Include index.html' }));
    expect([...(onChange.mock.lastCall?.[0] ?? [])]).toEqual(['index.html']);

    const folder = screen.getByRole('checkbox', { name: 'Include everything in css' });
    expect(folder.getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('checkbox', { name: 'Include css/site.css' }));
    expect(folder.getAttribute('aria-checked')).toBe('mixed');
    await user.click(folder);
    expect(folder.getAttribute('aria-checked')).toBe('true');
    await user.click(folder);
    expect(folder.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('1 of 4 files ticked')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(onChange.mock.lastCall?.[0].size).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Select none' }));
    expect(onChange.mock.lastCall?.[0].size).toBe(4);
    expect(screen.getByText('0 of 4 files ticked')).toBeTruthy();
  });

  it('applies Select none only to the files the filter shows', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<Harness onChange={onChange} />);

    await user.click(
      within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: /Added/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Select none' }));
    expect([...(onChange.mock.lastCall?.[0] ?? [])].sort()).toEqual([
      'css/site.css',
      'img/logo.png',
    ]);
  });

  it('collapses and opens a folder', async () => {
    const { user } = renderWithProviders(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Collapse css' }));
    expect(screen.queryByText('css/site.css')).toBeNull();
    const expand = screen.getByRole('button', { name: 'Expand css' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    await user.click(expand);
    expect(screen.getByText('css/site.css')).toBeTruthy();
  });

  it('draws at most 500 rows and offers the rest', async () => {
    const many = Array.from({ length: 520 }, (_, index) =>
      pending(`pages/page-${String(index).padStart(3, '0')}.html`, 'added', 10),
    );
    const { user } = renderWithProviders(<Harness files={many} />);

    // Counted by selector: asking for 500 accessible names is slow in jsdom.
    const rows = () => list().querySelectorAll('[role="checkbox"][aria-label^="Include pages/"]');
    expect(rows()).toHaveLength(500);
    await user.click(screen.getByRole('button', { name: 'Show 20 more' }));
    expect(rows()).toHaveLength(520);
    // Drawing 520 rows is quick in the app but slow in jsdom, more so under coverage.
  }, 60_000);

  it('lists what is left out with the reason, and explains the reason on focus', async () => {
    const { user } = renderWithProviders(
      <Harness
        leftOut={[
          { path: '.env', reason: 'hardDenied' },
          { path: '.claude/settings.json', reason: 'agentFiles' },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Left out 2/ }));
    const leftOut = screen.getByRole('list', { name: 'Left out' });
    expect(within(leftOut).getByText('.claude/settings.json')).toBeTruthy();
    const reason = within(leftOut).getByText('Never sent');
    fireEvent.focus(reason);
    expect((await screen.findAllByText(/never leave this computer/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('list', { name: 'Changed files' })).toBeNull();
  });

  it('says when more were left out than the list carries', async () => {
    const { user } = renderWithProviders(
      <ChangesList
        snapshot={snapshot({ leftOut: [{ path: 'a', reason: 'ignored' }], leftOutTruncated: true })}
        deselected={new Set()}
        onDeselectedChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Left out/ }));
    expect(screen.getByText(/More files were left out than are listed here/)).toBeTruthy();
  });

  it('says nothing is left out when that is so', async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: /Left out/ }));
    expect(screen.getByText('Nothing in the deploy folder is left out.')).toBeTruthy();
  });

  it('locks the ticks while a deploy runs', () => {
    renderWithProviders(<Harness disabled />);
    expect(
      screen.getByRole('checkbox', { name: 'Include index.html' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Select none' }).hasAttribute('disabled')).toBe(true);
  });
});
