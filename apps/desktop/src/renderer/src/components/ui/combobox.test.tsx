import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Combobox } from './combobox';

const POLICIES = [
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' },
  { value: 'reject', label: 'Reject' },
];

describe('Combobox', () => {
  it('opens with a search box by default', async () => {
    const user = userEvent.setup();
    render(<Combobox ariaLabel="Policy" options={POLICIES} value="deny" onChange={vi.fn()} />);

    await user.click(screen.getByRole('combobox', { name: 'Policy' }));
    expect(await screen.findByPlaceholderText('Search…')).toHaveFocus();
  });

  it('drops the search box for a short list and still works from the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Combobox
        ariaLabel="Policy"
        searchable={false}
        options={POLICIES}
        value="deny"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Policy' }));
    expect(await screen.findByRole('option', { name: 'Deny' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByPlaceholderText('Search…')).toBeNull();

    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('reject');
  });
});
