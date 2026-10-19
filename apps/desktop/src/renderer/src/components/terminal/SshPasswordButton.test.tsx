import { act, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { SshPasswordButton } from './SshPasswordButton';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

function renderButton(typed = true) {
  const onTyped = vi.fn();
  const view = renderWithProviders(<SshPasswordButton sessionId="s1" onTyped={onTyped} />);
  view.bridge.$set(
    'ssh.typePassword',
    vi.fn(async () => typed),
  );
  const prompt = (sessionId: string, prompting: boolean): void =>
    act(() => view.bridge.$emit('ssh.onPasswordPrompt', { sessionId, prompting }));
  return { ...view, onTyped, prompt };
}

const button = () => screen.queryByRole('button', { name: 'Enter saved password' });

afterEach(() => {
  vi.mocked(toast.error).mockClear();
});

describe('SshPasswordButton', () => {
  it('shows only while this session sits on a password prompt', () => {
    const { prompt } = renderButton();
    expect(button()).toBeNull();

    prompt('other-tab', true);
    expect(button()).toBeNull();

    prompt('s1', true);
    expect(button()).not.toBeNull();

    prompt('s1', false);
    expect(button()).toBeNull();
  });

  it('asks main to type the password, then hands focus back to the terminal', async () => {
    const { user, bridge, onTyped, prompt } = renderButton();
    prompt('s1', true);

    await user.click(button() as HTMLElement);

    expect(bridge.$fn('ssh.typePassword')).toHaveBeenCalledWith('s1');
    expect(button()).toBeNull();
    expect(onTyped).toHaveBeenCalled();
  });

  it('says so when there was no password to type', async () => {
    const { user, prompt } = renderButton(false);
    prompt('s1', true);

    await user.click(button() as HTMLElement);

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't read the saved password. Type it in the terminal instead.",
    );
    expect(button()).not.toBeNull();
  });
});
