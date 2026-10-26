import type { AvdSummary } from '@runova/core';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { EditAvdDialog } from './EditAvdDialog';

/**
 * Editing an existing device. Only what `config.ini` can safely be rewritten for is offered, and
 * the dialog says plainly why the system image is not on that list rather than leaving a control
 * that looks broken.
 */

const AVD: AvdSummary = {
  name: 'Pixel_7_API_34',
  displayName: 'Pixel 7 API 34',
  device: 'pixel_7',
  manufacturer: 'Google',
  api: 34,
  tag: 'google_apis',
  abi: 'x86_64',
  playStore: false,
  ramMb: 2048,
  storageMb: 6144,
  gpuMode: 'auto',
  systemImageDir: null,
  path: null,
};

const ADVANCED = {
  vmHeapMb: 256,
  cores: 2,
  sdCardMb: 512,
  cameraFront: 'emulated',
  cameraBack: 'virtualscene',
  networkSpeed: 'full',
  networkLatency: 'none',
  keyboard: true,
  deviceFrame: false,
  coldBootAlways: false,
};

function setup(overrides: Record<string, unknown> = {}, avd = AVD, running = false) {
  const onSaved = vi.fn();
  const view = renderWithProviders(
    <EditAvdDialog open avd={avd} running={running} onOpenChange={vi.fn()} onSaved={onSaved} />,
    {
      bridge: {
        'android.editAvd': { ok: true },
        'android.avdConfig': ADVANCED,
        ...overrides,
      },
    },
  );
  return { ...view, onSaved };
}

/** Opens the advanced half, which is folded away until asked for. */
async function showAdvanced(user: ReturnType<typeof setup>['user']): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /advanced settings/i }));
}

describe('EditAvdDialog', () => {
  it('starts from what the device is set to now', async () => {
    setup();

    expect(await screen.findByLabelText('Name')).toHaveValue('Pixel 7 API 34');
    expect(screen.getByLabelText(/RAM/)).toHaveValue(2048);
    expect(screen.getByLabelText(/Internal storage/)).toHaveValue(6144);
  });

  it('sends only what was actually changed', async () => {
    const { bridge, user } = setup();

    const ram = await screen.findByLabelText(/RAM/);
    await user.clear(ram);
    await user.type(ram, '4096');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // Writing back an unchanged value would rewrite lines of config.ini for no reason.
    await waitFor(() =>
      expect(bridge.$fn('android.editAvd')).toHaveBeenCalledWith('Pixel_7_API_34', {
        ramMb: 4096,
      }),
    );
  });

  it('will not save a RAM size the emulator would refuse', async () => {
    const { user } = setup();

    const ram = await screen.findByLabelText(/RAM/);
    await user.clear(ram);
    await user.type(ram, '16');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/at least 512 MB/i)).toBeInTheDocument();
  });

  it('will not save an empty name', async () => {
    const { user } = setup();

    await user.clear(await screen.findByLabelText('Name'));

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says why the system image cannot be changed here', async () => {
    setup();

    // Offering a control that quietly does nothing would be worse than not offering it.
    expect(await screen.findByText(/Android 14 \(API 34\)/)).toBeInTheDocument();
    expect(screen.getByText(/delete this device and create a new one/i)).toBeInTheDocument();
  });

  it('warns that a running device only picks the change up on its next start', async () => {
    setup({}, AVD, true);

    expect(await screen.findByText(/next time it starts/i)).toBeInTheDocument();
  });

  it('reports a failure instead of closing as if it worked', async () => {
    const { onSaved, user } = setup({
      'android.editAvd': { ok: false, message: 'Could not read the settings.' },
    });

    const ram = await screen.findByLabelText(/RAM/);
    await user.clear(ram);
    await user.type(ram, '4096');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('Could not read the settings.')).toBeVisible());
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('the advanced settings', () => {
  it('stays folded away until it is asked for, the way Studio does it', async () => {
    setup();

    await screen.findByLabelText('Name');
    expect(screen.queryByLabelText(/Multi-core CPU/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /advanced settings/i })).toBeInTheDocument();
  });

  it('opens on what the config file actually says, not on defaults', async () => {
    const { user, bridge } = setup();

    await showAdvanced(user);

    // Reading first is the point: saving a default over a value set in Studio would be silent.
    await waitFor(() => expect(bridge.$fn('android.avdConfig')).toHaveBeenCalledWith(AVD.name));
    expect(await screen.findByLabelText(/Multi-core CPU/i)).toHaveValue(2);
    expect(screen.getByLabelText(/VM heap/i)).toHaveValue(256);
    expect(screen.getByLabelText(/SD card/i)).toHaveValue(512);
  });

  it('groups the settings the way the Studio panel does', async () => {
    const { user } = setup();

    await showAdvanced(user);

    for (const group of ['Emulated performance', 'Memory and storage', 'Camera', 'Network']) {
      expect(await screen.findByText(group)).toBeInTheDocument();
    }
  });

  it('saves an advanced change on its own', async () => {
    const { user, bridge } = setup();
    await showAdvanced(user);

    const cores = await screen.findByLabelText(/Multi-core CPU/i);
    await user.clear(cores);
    await user.type(cores, '4');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(bridge.$fn('android.editAvd')).toHaveBeenCalledWith(AVD.name, { cores: 4 }),
    );
  });

  it('saves a switch as the boolean it is', async () => {
    const { user, bridge } = setup();
    await showAdvanced(user);

    await user.click(await screen.findByLabelText(/Show the device frame/i));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(bridge.$fn('android.editAvd')).toHaveBeenCalledWith(AVD.name, { deviceFrame: true }),
    );
  });

  it('sends the basic and advanced changes together in one write', async () => {
    const { user, bridge } = setup();

    const ram = await screen.findByLabelText(/^RAM/);
    await user.clear(ram);
    await user.type(ram, '4096');
    await showAdvanced(user);
    const cores = await screen.findByLabelText(/Multi-core CPU/i);
    await user.clear(cores);
    await user.type(cores, '4');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // One rewrite of config.ini rather than two.
    await waitFor(() =>
      expect(bridge.$fn('android.editAvd')).toHaveBeenCalledWith(AVD.name, {
        ramMb: 4096,
        cores: 4,
      }),
    );
  });

  it('will not save a core count the emulator would refuse', async () => {
    const { user } = setup();
    await showAdvanced(user);

    const cores = await screen.findByLabelText(/Multi-core CPU/i);
    await user.clear(cores);
    await user.type(cores, '99');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/between 1 and 16/i)).toBeInTheDocument();
  });

  it('treats no SD card as a real choice rather than an empty field', async () => {
    const { user, bridge } = setup();
    await showAdvanced(user);

    const sd = await screen.findByLabelText(/SD card/i);
    await user.clear(sd);
    await user.type(sd, '0');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(bridge.$fn('android.editAvd')).toHaveBeenCalledWith(AVD.name, { sdCardMb: 0 }),
    );
  });
});
