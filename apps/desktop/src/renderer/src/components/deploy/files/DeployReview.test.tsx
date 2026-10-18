import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FilesReview } from '@/stores/deployFilesRunStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ConflictsCard, REVIEW_PAGE } from './ConflictsCard';
import { DeployReview } from './DeployReview';
import { plan, planChange } from './testing/fixtures';

/**
 * What the check of the server found, before anything is sent: conflicts to settle one by one,
 * a first deploy over a folder that already has files, files gone from the server, and the
 * notes that need no choice.
 */

const NOW = Date.now();

const CHANGED = planChange('about.html', {
  action: 'conflict',
  conflict: 'changedOnServer',
  size: 2048,
  server: { size: 3072, mtimeMs: NOW - 5 * 60_000, via: 'sftp' },
  base: { size: 2000, mtimeMs: NOW - 86_400_000 * 2, via: 'sftp' },
});
const GONE = planChange('contact.html', {
  action: 'conflict',
  conflict: 'deletedOnServer',
  remote: 'missing',
});
const DELETED_HERE = planChange('old.html', {
  local: 'deleted',
  action: 'conflict',
  conflict: 'changedOnServer',
});
const EXISTS = planChange('robots.txt', {
  local: 'added',
  action: 'conflict',
  conflict: 'existsOnServer',
  server: { size: 10, mtimeMs: null, via: null },
});

function review(overrides: Partial<FilesReview> = {}): FilesReview {
  return {
    plan: plan({ changes: [CHANGED, GONE, DELETED_HERE, EXISTS] }),
    conflicts: { 'contact.html': 'overwrite' },
    firstDeploy: null,
    reupload: [],
    only: null,
    ...overrides,
  };
}

describe('ConflictsCard', () => {
  it('says what happened to each file on the server, with sizes and times when known', () => {
    renderWithProviders(
      <ConflictsCard
        conflicts={[CHANGED, GONE, DELETED_HERE, EXISTS]}
        choices={{}}
        onChoose={vi.fn()}
      />,
    );

    const card = screen.getByRole('region', { name: 'Conflicts' });
    expect(within(card).getByText('4 files changed on the server')).toBeTruthy();
    const row = within(card).getByText('about.html').closest('li') as HTMLElement;
    expect(within(row).getByText('Changed on the server since your last deploy.')).toBeTruthy();
    expect(within(row).getByText(/On the server now: 3.00 KB, 5 min ago/)).toBeTruthy();
    expect(within(row).getByText(/At your last deploy: 1.95 KB, 2 days ago/)).toBeTruthy();
    expect(within(row).getByText(/This computer: 2.00 KB/)).toBeTruthy();
    const robots = within(card).getByText('robots.txt').closest('li') as HTMLElement;
    expect(within(robots).getByText(/On the server now: 10 B$/)).toBeTruthy();
  });

  it('names the choices after what they do to each kind of conflict', () => {
    renderWithProviders(
      <ConflictsCard conflicts={[CHANGED, GONE, DELETED_HERE]} choices={{}} onChoose={vi.fn()} />,
    );

    const choices = (path: string) =>
      within(screen.getByRole('radiogroup', { name: `What to do with ${path}` }))
        .getAllByRole('radio')
        .map((radio) => radio.textContent);
    expect(choices('about.html')).toEqual(['Overwrite', 'Skip']);
    expect(choices('contact.html')).toEqual(['Upload', 'Skip']);
    expect(choices('old.html')).toEqual(['Delete', 'Keep']);
  });

  it('takes a choice per file, and for all of them at once', async () => {
    const onChoose = vi.fn();
    const { user } = renderWithProviders(
      <ConflictsCard
        conflicts={[CHANGED, GONE]}
        choices={{ 'contact.html': 'overwrite' }}
        onChoose={onChoose}
      />,
    );

    const group = screen.getByRole('radiogroup', { name: 'What to do with contact.html' });
    expect(within(group).getByRole('radio', { name: 'Upload' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await user.click(
      within(screen.getByRole('radiogroup', { name: 'What to do with about.html' })).getByRole(
        'radio',
        { name: 'Skip' },
      ),
    );
    expect(onChoose).toHaveBeenLastCalledWith({ 'about.html': 'skip' });
    await user.click(screen.getByRole('button', { name: 'Overwrite all' }));
    expect(onChoose).toHaveBeenLastCalledWith({
      'about.html': 'overwrite',
      'contact.html': 'overwrite',
    });
    await user.click(screen.getByRole('button', { name: 'Skip all' }));
    expect(onChoose).toHaveBeenLastCalledWith({ 'about.html': 'skip', 'contact.html': 'skip' });
  });

  it('moves between the two choices with the arrow keys', async () => {
    const onChoose = vi.fn();
    const { user } = renderWithProviders(
      <ConflictsCard
        conflicts={[CHANGED]}
        choices={{ 'about.html': 'overwrite' }}
        onChoose={onChoose}
      />,
    );
    const overwrite = screen.getByRole('radio', { name: 'Overwrite' });
    overwrite.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChoose).toHaveBeenLastCalledWith({ 'about.html': 'skip' });
  });

  it('draws the first page of a long list and the rest on request, while "all" covers every one', async () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      planChange(`page-${index}.html`, { action: 'conflict', conflict: 'changedOnServer' }),
    );
    const onChoose = vi.fn();
    const { user } = renderWithProviders(
      <ConflictsCard conflicts={many} choices={{}} onChoose={onChoose} />,
    );
    const list = screen.getByRole('list', { name: 'Conflicting files' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(REVIEW_PAGE);
    await user.click(screen.getByRole('button', { name: `Show ${REVIEW_PAGE} more` }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(REVIEW_PAGE * 2);
    await user.click(screen.getByRole('button', { name: `Show ${120 - REVIEW_PAGE * 2} more` }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(120);
    expect(screen.queryByRole('button', { name: /^Show \d+ more/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Skip all' }));
    expect(Object.keys(onChoose.mock.lastCall?.[0] ?? {})).toHaveLength(120);
  });

  it('draws nothing without conflicts', () => {
    const { container } = renderWithProviders(
      <ConflictsCard conflicts={[]} choices={{}} onChoose={vi.fn()} />,
    );
    expect(container.querySelector('section')).toBeNull();
  });
});

describe('DeployReview', () => {
  function renderReview(
    value: FilesReview,
    extra: Partial<Parameters<typeof DeployReview>[0]> = {},
  ) {
    const props = {
      review: value,
      allowed: new Set(value.plan.changes.map((change) => change.path)),
      onChooseConflicts: vi.fn(),
      onChooseFirstDeploy: vi.fn(),
      onReupload: vi.fn(),
      onContinue: vi.fn(),
      onCancel: vi.fn(),
      ...extra,
    };
    return { ...renderWithProviders(<DeployReview {...props} />), props };
  }

  it('keeps Continue off until every conflict has a choice', async () => {
    const { user, props } = renderReview(review());

    const go = screen.getByRole('button', { name: /Continue/ });
    expect(go.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Choose what to do with each conflict first.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(props.onCancel).toHaveBeenCalled();
  });

  it('continues once each conflict has a choice', async () => {
    const { user, props } = renderReview(
      review({
        conflicts: {
          'about.html': 'skip',
          'contact.html': 'overwrite',
          'old.html': 'skip',
          'robots.txt': 'overwrite',
        },
      }),
    );
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(props.onContinue).toHaveBeenCalled();
  });

  it('only asks about the conflicts among the ticked files', () => {
    renderReview(review(), { allowed: new Set(['contact.html']) });
    expect(screen.getByText('1 file changed on the server')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Continue/ }).hasAttribute('disabled')).toBe(false);
  });

  it('offers to skip same-size files on a first deploy, recommended, or to overwrite them all', async () => {
    const onChooseFirstDeploy = vi.fn();
    const { user } = renderReview(
      review({
        plan: plan({ firstDeploy: { existing: 214, sameSize: 200 } }),
        conflicts: {},
        firstDeploy: 'adoptSameSize',
      }),
      { onChooseFirstDeploy },
    );

    const card = screen.getByRole('region', { name: 'First deploy' });
    expect(within(card).getByText('This folder on the server already has 214 files')).toBeTruthy();
    const skip = within(card).getByRole('radio', { name: /Skip files with the same size/ });
    expect(skip.getAttribute('aria-checked')).toBe('true');
    expect(within(skip).getByText('Recommended')).toBeTruthy();
    expect(within(card).getByText(/200 files with the same size/)).toBeTruthy();
    await user.click(within(card).getByRole('radio', { name: /Overwrite all/ }));
    expect(onChooseFirstDeploy).toHaveBeenCalledWith('overwrite');
  });

  it('warns about a mass delete and explains each note from the check', () => {
    renderReview(
      review({
        plan: plan({
          massDelete: true,
          deleteCount: 30,
          notices: ['sizeOnly', 'notAtomic', 'mdtmCapped', 'clockShift'],
          clockShiftHours: 1,
          serverOnlyDrift: ['blog/a.html', 'blog/b.html'],
        }),
        conflicts: {},
      }),
    );

    expect(screen.getByRole('alert').textContent).toMatch(/deletes 30 files from the server/);
    expect(screen.getByText(/judged by size alone/)).toBeTruthy();
    expect(screen.getByText(/can't replace a file in one step/)).toBeTruthy();
    expect(screen.getByText(/too many files to ask the server/)).toBeTruthy();
    expect(screen.getByText(/moved by 1 hour\b/)).toBeTruthy();
    const drift = screen.getByRole('list', { name: 'Changed on the server only' });
    expect(within(drift).getByText('blog/a.html')).toBeTruthy();
  });

  it('offers files gone from the server for upload again, unticked', async () => {
    const onReupload = vi.fn();
    const { user, unmount } = renderReview(
      review({ plan: plan({ missingOnServer: ['js/app.js', 'js/vendor.js'] }), conflicts: {} }),
      { onReupload },
    );

    const list = screen.getByRole('list', { name: 'Missing on the server' });
    const box = within(list).getByRole('checkbox', { name: 'Upload js/app.js again' });
    expect(box.getAttribute('aria-checked')).toBe('false');
    await user.click(box);
    expect(onReupload).toHaveBeenLastCalledWith(['js/app.js']);
    unmount();

    const again = renderReview(
      review({
        plan: plan({ missingOnServer: ['js/app.js', 'js/vendor.js'] }),
        conflicts: {},
        reupload: ['js/app.js'],
      }),
      { onReupload },
    );
    await again.user.click(screen.getByRole('checkbox', { name: 'Upload js/app.js again' }));
    expect(onReupload).toHaveBeenLastCalledWith([]);
    await again.user.click(screen.getByRole('button', { name: 'Upload all again' }));
    expect(onReupload).toHaveBeenLastCalledWith(['js/app.js', 'js/vendor.js']);
  });

  it('pages a long list of files gone from the server, and unticks them all at once', async () => {
    const missing = Array.from({ length: 70 }, (_, index) => `js/chunk-${index}.js`);
    const onReupload = vi.fn();
    const { user } = renderReview(
      review({ plan: plan({ missingOnServer: missing }), conflicts: {}, reupload: missing }),
      { onReupload },
    );
    const list = screen.getByRole('list', { name: 'Missing on the server' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(REVIEW_PAGE);
    await user.click(screen.getByRole('button', { name: `Show ${70 - REVIEW_PAGE} more` }));
    expect(within(list).getAllByRole('checkbox')).toHaveLength(70);
    await user.click(screen.getByRole('button', { name: 'Upload none' }));
    expect(onReupload).toHaveBeenLastCalledWith([]);
  });

  it('moves between the first deploy choices with the arrow keys, one tab stop for the group', async () => {
    const onChooseFirstDeploy = vi.fn();
    const { user } = renderReview(
      review({
        plan: plan({ firstDeploy: { existing: 214, sameSize: 200 } }),
        conflicts: {},
        firstDeploy: 'adoptSameSize',
      }),
      { onChooseFirstDeploy },
    );
    const group = screen.getByRole('radiogroup', { name: 'Files already on the server' });
    const [skip, overwrite] = within(group).getAllByRole('radio');
    expect(skip.tabIndex).toBe(0);
    expect(overwrite.tabIndex).toBe(-1);
    skip.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChooseFirstDeploy).toHaveBeenLastCalledWith('overwrite');
    expect(document.activeElement).toBe(overwrite);
    await user.keyboard('{ArrowLeft}');
    expect(onChooseFirstDeploy).toHaveBeenLastCalledWith('adoptSameSize');
    expect(document.activeElement).toBe(skip);
  });

  it('shows the long drift list in part', () => {
    renderReview(
      review({
        plan: plan({ serverOnlyDrift: Array.from({ length: 14 }, (_, index) => `f${index}.txt`) }),
        conflicts: {},
      }),
    );
    expect(screen.getByText('and 4 more')).toBeTruthy();
  });

  it('shows a working button while the deploy starts', () => {
    renderReview(review({ conflicts: {}, plan: plan() }), { continuing: true });
    expect(screen.getByRole('button', { name: /Starting/ }).hasAttribute('disabled')).toBe(true);
  });
});
