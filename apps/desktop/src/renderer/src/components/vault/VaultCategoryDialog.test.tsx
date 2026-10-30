// @vitest-environment jsdom
import { encodeVaultError } from '@shared/vaultErrors';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  category,
  createVaultApiMock,
  expectNoNativeTitles,
  installDomShims,
  installVaultApi,
  renderWithVaultProviders,
  type VaultApiMock,
} from './testing/mockVaultApi';

installDomShims();

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { VaultCategoryDialog } = await import('./VaultCategoryDialog');

let mock: VaultApiMock;
const onOpenChange = vi.fn();
const onSaved = vi.fn();

const dialog = () => screen.getByRole('dialog');
const nameField = () => within(dialog()).getByLabelText('Name') as HTMLInputElement;

beforeEach(() => {
  mock = createVaultApiMock();
  installVaultApi(mock);
  vi.clearAllMocks();
  mock.api.saveCategory.mockImplementation(async (input: object) =>
    category({ id: 'made', ...input }),
  );
});

afterEach(() => {
  expectNoNativeTitles();
  cleanup();
});

describe('VaultCategoryDialog', () => {
  it('creates a category with the picked name, color and icon', async () => {
    renderWithVaultProviders(
      <VaultCategoryDialog open onOpenChange={onOpenChange} onSaved={onSaved} />,
    );
    expect(screen.getByRole('dialog', { name: 'New category' })).toBeTruthy();
    expect(document.activeElement).toBe(nameField());

    fireEvent.change(nameField(), { target: { value: 'Clients' } });
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Violet' }));
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Work' }));
    expect(
      within(dialog()).getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked'),
    ).toBe('true');
    // The preview shows what the rail will show.
    expect(within(dialog()).getByTestId('category-preview').textContent).toContain('Clients');

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create category' }));
    await waitFor(() =>
      expect(mock.api.saveCategory).toHaveBeenCalledWith({
        name: 'Clients',
        color: 'violet',
        icon: 'briefcase',
      }),
    );
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'made' })),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the create button off until there is a name', () => {
    renderWithVaultProviders(<VaultCategoryDialog open onOpenChange={onOpenChange} />);
    const create = within(dialog()).getByRole('button', { name: 'Create category' });
    expect(create.hasAttribute('disabled')).toBe(true);
    fireEvent.change(nameField(), { target: { value: '   ' } });
    expect(create.hasAttribute('disabled')).toBe(true);
    fireEvent.change(nameField(), { target: { value: 'Home' } });
    expect(create.hasAttribute('disabled')).toBe(false);
  });

  it('edits an existing category, starting from what it has', async () => {
    const existing = category({ id: 'work', name: 'Work', color: 'green', icon: 'code' });
    renderWithVaultProviders(
      <VaultCategoryDialog open onOpenChange={onOpenChange} category={existing} />,
    );
    expect(screen.getByRole('dialog', { name: 'Edit category' })).toBeTruthy();
    expect(nameField().value).toBe('Work');
    expect(
      within(dialog()).getByRole('radio', { name: 'Green' }).getAttribute('aria-checked'),
    ).toBe('true');

    fireEvent.change(nameField(), { target: { value: 'Job' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.api.saveCategory).toHaveBeenCalledWith({
        id: 'work',
        name: 'Job',
        color: 'green',
        icon: 'code',
      }),
    );
  });

  it('shows why main refused, and stays open', async () => {
    mock.api.saveCategory.mockRejectedValue(
      new Error(encodeVaultError('invalid', 'There is already a category called "Work".')),
    );
    renderWithVaultProviders(<VaultCategoryDialog open onOpenChange={onOpenChange} />);
    fireEvent.change(nameField(), { target: { value: 'work' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create category' }));
    expect((await within(dialog()).findByRole('alert')).textContent).toMatch(/already/);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
