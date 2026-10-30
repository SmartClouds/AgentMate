import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { CopyButton } from './copy-button';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  vi.useRealTimers();
});

describe('CopyButton', () => {
  it('copies the exact text and says so for a moment', async () => {
    const { user } = renderWithProviders(
      <CopyButton text={'line one\n  line two'} label="Copy message" />,
    );
    await user.click(screen.getByRole('button', { name: 'Copy message' }));

    expect(await navigator.clipboard.readText()).toBe('line one\n  line two');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
  });

  it('goes back to its label after a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = renderWithProviders(<CopyButton text="x" label="Copy command" />);
    await user.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
  });

  it('says when the clipboard refused', async () => {
    const { user } = renderWithProviders(<CopyButton text="x" label="Copy message" />);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy message' }));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy that.'));
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
  });

  it('stays quiet until its message is hovered, unless asked to show', () => {
    renderWithProviders(
      <>
        <CopyButton text="a" label="Quiet" />
        <CopyButton text="b" label="Shown" alwaysVisible />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Quiet' })).toHaveClass('opacity-0');
    expect(screen.getByRole('button', { name: 'Shown' })).not.toHaveClass('opacity-0');
  });
});
