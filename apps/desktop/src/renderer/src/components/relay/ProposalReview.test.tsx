import type { ProposalEntry, RelayProposal } from '@runova/core';
import { screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ProposalReview } from './ProposalReview';

const PROPOSAL: RelayProposal = {
  summary: 'Search in three tasks.',
  add: [
    { id: 'T014', title: 'Search API', estimate: 90_000, depends: [] },
    { id: 'T015', title: 'Search UI', estimate: 130_000, depends: ['T014'] },
    { id: 'T016', title: 'Everything at once', estimate: 260_000 },
  ],
  change: [{ id: 'T004', title: 'Export to CSV', estimate: 120_000 }],
  split: [{ id: 'T005', into: [{ id: 'T017', title: 'Part one' }] }],
  remove: [{ id: 'T009', reason: 'The docs dropped it.' }],
};

const ENTRIES: ProposalEntry[] = [
  { kind: 'add', id: 'T014', title: 'Search API', fields: [] },
  { kind: 'add', id: 'T015', title: 'Search UI', fields: [] },
  { kind: 'add', id: 'T016', title: 'Everything at once', fields: [] },
  {
    kind: 'change',
    id: 'T004',
    title: 'Export to CSV',
    fields: [
      { field: 'title', before: 'Export', after: 'Export to CSV' },
      { field: 'estimate', before: '250K', after: '120K' },
    ],
  },
  {
    kind: 'split',
    id: 'T005',
    title: 'Reports',
    fields: [],
    parts: [{ id: 'T017', title: 'Part one' }],
  },
  { kind: 'remove', id: 'T009', title: 'Old export', fields: [], reason: 'The docs dropped it.' },
];

/** Holds the edited proposal the way a dialog does, and reports every change. */
function Harness({ onChange }: { onChange: (next: RelayProposal) => void }) {
  const [, setProposal] = useState(PROPOSAL);
  return (
    <ProposalReview
      proposal={PROPOSAL}
      entries={ENTRIES}
      budget={200_000}
      warnings={['T001 is done, so it was not changed.']}
      onChange={(next) => {
        setProposal(next);
        onChange(next);
      }}
    />
  );
}

function lastProposal(onChange: ReturnType<typeof vi.fn>): RelayProposal {
  return onChange.mock.calls.at(-1)?.[0] as RelayProposal;
}

describe('ProposalReview', () => {
  it('lists every proposed change with what it does', () => {
    renderWithProviders(<Harness onChange={vi.fn()} />);

    expect(screen.getByText('Search in three tasks.')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: /New task T014/ })).toBeInTheDocument();
    const change = screen.getByRole('listitem', { name: /Change T004/ });
    expect(within(change).getByText('250K')).toBeInTheDocument();
    expect(within(change).getByText('120K')).toBeInTheDocument();
    const split = screen.getByRole('listitem', { name: /Split T005/ });
    expect(within(split).getByText('Part one')).toBeInTheDocument();
    const remove = screen.getByRole('listitem', { name: /Remove T009/ });
    expect(within(remove).getByText('The docs dropped it.')).toBeInTheDocument();
    expect(screen.getByText('T001 is done, so it was not changed.')).toBeInTheDocument();
  });

  it('reads each new task against the budget', () => {
    renderWithProviders(<Harness onChange={vi.fn()} />);

    expect(
      within(screen.getByRole('listitem', { name: /New task T014/ })).getByText('Fits'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: /New task T015/ })).getByText('Tight'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: /New task T016/ })).getByText('Over budget'),
    ).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'T014 estimate' })).toHaveAttribute(
      'aria-valuenow',
      '90000',
    );
  });

  it('leaves out an entry the user drops', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Leave out T016' }));
    await user.click(screen.getByRole('button', { name: 'Leave out T009' }));

    const next = lastProposal(onChange);
    expect(next.add.map((task) => task.id)).toEqual(['T014', 'T015']);
    expect(next.remove).toEqual([]);
    expect(next.change).toHaveLength(1);
    expect(screen.queryByRole('listitem', { name: /New task T016/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo leaving out T016' })).toBeInTheDocument();
  });

  it('brings a dropped entry back', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Leave out T016' }));
    await user.click(screen.getByRole('button', { name: 'Undo leaving out T016' }));

    expect(lastProposal(onChange).add).toHaveLength(3);
  });

  it('applies a new title and estimate to the task', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<Harness onChange={onChange} />);

    const title = screen.getByRole('textbox', { name: 'Title of T014' });
    await user.clear(title);
    await user.type(title, 'Search endpoint');
    const estimate = screen.getByRole('textbox', { name: 'Estimate of T014' });
    await user.clear(estimate);
    await user.type(estimate, '60k');
    await user.tab();

    const next = lastProposal(onChange);
    expect(next.add[0]).toMatchObject({ id: 'T014', title: 'Search endpoint', estimate: 60_000 });
    expect(
      within(screen.getByRole('listitem', { name: /New task T014/ })).getByText('Fits'),
    ).toBeInTheDocument();
  });

  it('keeps the old estimate when the new one cannot be read', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<Harness onChange={onChange} />);

    const estimate = screen.getByRole('textbox', { name: 'Estimate of T014' });
    await user.clear(estimate);
    await user.type(estimate, 'lots');
    await user.tab();

    expect(estimate).toHaveValue('90K');
    expect(onChange.mock.calls.every((call) => call[0].add[0].estimate === 90_000)).toBe(true);
  });

  it('only shows the proposal when it is read-only', () => {
    renderWithProviders(
      <ProposalReview
        readOnly
        proposal={PROPOSAL}
        entries={ENTRIES}
        budget={200_000}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('listitem', { name: /New task T014/ })).toBeInTheDocument();
    expect(screen.getByText('Search API')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Leave out/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'T016 estimate' })).toBeInTheDocument();
  });

  it('shows finished work as done and half-done work as starting from a handoff', () => {
    const proposal: RelayProposal = {
      summary: '',
      add: [
        { title: 'Login', status: 'done', estimate: 40_000, handoff: { done: 'Built.' } },
        { title: 'Search', estimate: 90_000, handoff: { done: 'The API.', next: 'The page.' } },
      ],
      change: [{ id: 'T004', status: 'done', handoff: { done: 'Built.' } }],
      split: [],
      remove: [],
    };
    renderWithProviders(
      <ProposalReview
        proposal={proposal}
        entries={[
          { kind: 'add', id: 'T010', title: 'Login', fields: [], status: 'done', handoff: true },
          { kind: 'add', id: 'T011', title: 'Search', fields: [], handoff: true },
          {
            kind: 'change',
            id: 'T004',
            title: 'Export',
            fields: [{ field: 'status', before: 'todo', after: 'done' }],
            handoff: true,
          },
        ]}
        budget={200_000}
        onChange={vi.fn()}
      />,
    );
    const done = screen.getByRole('listitem', { name: /^Finished task T010 Login/ });
    // A finished task needs no session, so it is not read against the budget.
    expect(within(done).queryByRole('meter')).not.toBeInTheDocument();
    const half = screen.getByRole('listitem', { name: /^New task T011 Search/ });
    expect(within(half).getByText('Half done')).toBeInTheDocument();
    expect(within(half).getByRole('meter', { name: 'T011 estimate' })).toBeInTheDocument();
    const change = screen.getByRole('listitem', { name: /^Change T004/ });
    expect(within(change).getByText('Status')).toBeInTheDocument();
    expect(within(change).getByText('With a handoff')).toBeInTheDocument();
  });

  it('never uses the native title attribute', () => {
    const { container } = renderWithProviders(<Harness onChange={vi.fn()} />);
    expect(container.querySelector('[title]')).toBeNull();
  });
});
