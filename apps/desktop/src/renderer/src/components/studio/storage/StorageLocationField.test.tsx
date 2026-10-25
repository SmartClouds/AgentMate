import { screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { INSIDE_PROJECT, ok } from '../testing/fixtures';
import { StorageLocationField } from './StorageLocationField';

function Harness({ initial, onCheck }: { initial: string; onCheck?: (v: unknown) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <StorageLocationField
      label="Folder"
      value={value}
      onChange={setValue}
      projectId="p1"
      onCheck={onCheck}
    />
  );
}

describe('StorageLocationField', () => {
  it('says a good folder is fine', async () => {
    renderWithProviders(<Harness initial="D:\Videos" />, {
      bridge: { 'studio.checkRoot': async () => ok() },
    });
    expect(await screen.findByText('Studio can keep videos here.')).toBeInTheDocument();
  });

  it('says in words why a folder is refused, and marks the field', async () => {
    const onCheck = vi.fn();
    renderWithProviders(<Harness initial="C:\code\shop\videos" onCheck={onCheck} />, {
      bridge: { 'studio.checkRoot': async () => ok([INSIDE_PROJECT]) },
    });
    expect(await screen.findByText(/inside the project's folder/)).toBeInTheDocument();
    expect(screen.getByText('Not allowed:')).toBeInTheDocument();
    expect(screen.getByLabelText('Folder')).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() =>
      expect(onCheck).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false })),
    );
  });

  it('shows a warning as a note, still allowed', async () => {
    renderWithProviders(<Harness initial="C:\Users\me\OneDrive\Videos" />, {
      bridge: {
        'studio.checkRoot': async () =>
          ok([{ code: 'synced', level: 'warning', message: 'OneDrive syncs this folder.' }]),
      },
    });
    expect(await screen.findByText('OneDrive syncs this folder.')).toBeInTheDocument();
    expect(screen.getByText('Note:')).toBeInTheDocument();
  });

  it('checks again after the user stops typing, against the project', async () => {
    const { user, bridge } = renderWithProviders(<Harness initial="" />, {
      bridge: { 'studio.checkRoot': async () => ok() },
    });
    await user.type(screen.getByLabelText('Folder'), 'D:\\Media');
    await waitFor(() =>
      expect(bridge.$fn('studio.checkRoot')).toHaveBeenCalledWith('D:\\Media', 'p1'),
    );
  });

  it('fills the field from the folder picker', async () => {
    const { user } = renderWithProviders(<Harness initial="" />, {
      bridge: {
        'studio.pickFolder': async () => 'E:\\Films',
        'studio.checkRoot': async () => ok(),
      },
    });
    await user.click(screen.getByRole('button', { name: /Browse/ }));
    await waitFor(() => expect(screen.getByLabelText('Folder')).toHaveValue('E:\\Films'));
  });
});
