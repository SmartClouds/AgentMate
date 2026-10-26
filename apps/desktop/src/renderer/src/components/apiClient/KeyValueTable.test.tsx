import type { KeyValueRow } from '@runova/core';
import { screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { KeyValueTable } from './KeyValueTable';

/** The editable table behind Params, Headers and form bodies. */

function Harness({
  initial = [],
  onRows,
}: {
  initial?: KeyValueRow[];
  onRows?: (rows: KeyValueRow[]) => void;
}) {
  const [rows, setRows] = useState(initial);
  return (
    <KeyValueTable
      label="Headers"
      rows={rows}
      onChange={(next) => {
        setRows(next);
        onRows?.(next);
      }}
    />
  );
}

const row = (key: string, value: string, enabled = true): KeyValueRow => ({
  id: key,
  key,
  value,
  enabled,
  description: '',
});

describe('KeyValueTable', () => {
  it('always ends with an empty row that becomes a real one when typed in', async () => {
    const onRows = vi.fn();
    const { user } = renderWithProviders(<Harness onRows={onRows} />);

    const keys = screen.getAllByRole('textbox', { name: 'Headers key' });
    expect(keys).toHaveLength(1);
    await user.type(keys[0]!, 'Accept');

    expect(onRows).toHaveBeenLastCalledWith([
      expect.objectContaining({ key: 'Accept', value: '', enabled: true }),
    ]);
    expect(screen.getAllByRole('textbox', { name: 'Headers key' })).toHaveLength(2);
  });

  it('edits values and toggles rows on and off', async () => {
    const onRows = vi.fn();
    const { user } = renderWithProviders(
      <Harness initial={[row('Accept', 'json')]} onRows={onRows} />,
    );

    const value = screen.getAllByRole('textbox', { name: 'Headers value' })[0]!;
    await user.clear(value);
    await user.type(value, 'xml');
    expect(onRows).toHaveBeenLastCalledWith([expect.objectContaining({ value: 'xml' })]);

    await user.click(screen.getByRole('checkbox', { name: 'Include Accept' }));
    expect(onRows).toHaveBeenLastCalledWith([expect.objectContaining({ enabled: false })]);
  });

  it('removes a row', async () => {
    const onRows = vi.fn();
    const { user } = renderWithProviders(
      <Harness initial={[row('A', '1'), row('B', '2')]} onRows={onRows} />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove A' }));
    expect(onRows).toHaveBeenLastCalledWith([expect.objectContaining({ key: 'B' })]);
  });

  it('dims disabled rows', () => {
    renderWithProviders(<Harness initial={[row('Off', '1', false)]} />);
    expect(screen.getByDisplayValue('Off').closest('[data-row]')).toHaveAttribute(
      'data-disabled',
      'true',
    );
  });

  it('switches to bulk edit and back without losing rows', async () => {
    const onRows = vi.fn();
    const { user } = renderWithProviders(
      <Harness initial={[row('A', '1'), row('B', '2', false)]} onRows={onRows} />,
    );

    await user.click(screen.getByRole('button', { name: 'Bulk edit' }));
    const text = screen.getByRole('textbox', { name: 'Headers bulk edit' });
    expect(text).toHaveValue('A:1\n//B:2');

    await user.clear(text);
    await user.type(text, 'C:3{enter}//D:4');
    await user.click(screen.getByRole('button', { name: 'Key-value edit' }));

    expect(onRows).toHaveBeenLastCalledWith([
      expect.objectContaining({ key: 'C', value: '3', enabled: true }),
      expect.objectContaining({ key: 'D', value: '4', enabled: false }),
    ]);
    expect(screen.getByDisplayValue('C')).toBeInTheDocument();
  });
});
