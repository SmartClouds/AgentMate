import type { AndroidEmulator, AndroidPhysicalDevice, AvdSummary } from '@runova/core';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { DeviceCard } from './DeviceCard';

/**
 * A card has to make its state obvious at a glance and offer only the actions that make sense in
 * it. The two that matter most are the booting card, which must say what stage it is at rather
 * than spin silently for two minutes, and the unauthorized card, which must not offer to wipe
 * anything.
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

function emulator(overrides: Partial<AndroidEmulator> = {}): AndroidEmulator {
  return {
    kind: 'emulator',
    avd: AVD,
    state: 'stopped',
    serial: null,
    progress: 0,
    adopted: false,
    usage: null,
    lastLine: null,
    error: null,
    ...overrides,
  };
}

function physical(state: 'device' | 'unauthorized' | 'offline'): AndroidPhysicalDevice {
  return {
    kind: 'physical',
    device: {
      serial: 'R58M20ABCDE',
      state,
      kind: 'usb',
      model: 'Galaxy A52',
      product: 'a52qnaxx',
      device: 'a52q',
      transportId: '5',
    },
    androidVersion: state === 'device' ? '14' : null,
    api: state === 'device' ? 34 : null,
  };
}

const actions = {
  onStart: vi.fn(),
  onStop: vi.fn(),
  onCancelBoot: vi.fn(),
  onScreenshot: vi.fn(),
  onToggleRecording: vi.fn(),
  onRotate: vi.fn(),
  onOpenShell: vi.fn(),
  onInstallApk: vi.fn(),
  onEdit: vi.fn(),
  onColdBoot: vi.fn(),
  onWipeData: vi.fn(),
  onDelete: vi.fn(),
  recordingSerial: null,
};

function render(device: AndroidEmulator | AndroidPhysicalDevice) {
  return renderWithProviders(<DeviceCard device={device} pending={false} {...actions} />);
}

describe('a stopped virtual device', () => {
  it('offers Start and describes the hardware', () => {
    render(emulator());

    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.getByText('Pixel 7 API 34')).toBeInTheDocument();
    // The meta line, which is separate from the name and is where the hardware is spelled out.
    expect(screen.getByText('API 34 · x86_64 · 2048 MB RAM')).toBeInTheDocument();
  });

  it('offers nothing that only makes sense while it runs', () => {
    render(emulator());

    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Screenshot' })).not.toBeInTheDocument();
  });
});

describe('a booting virtual device', () => {
  it('names the stage and shows real progress, not a bare spinner', () => {
    render(emulator({ state: 'booting', serial: 'emulator-5554', progress: 55 }));

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '55');
    expect(screen.getByText('Booting Android')).toBeInTheDocument();
  });

  it('replaces Start with Cancel, since starting again would fail on the lock file', () => {
    render(emulator({ state: 'launching', serial: 'emulator-5554', progress: 10 }));

    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});

describe('a running virtual device', () => {
  const running = emulator({ state: 'running', serial: 'emulator-5554', progress: 100 });

  it('shows the serial and offers Stop', () => {
    render(running);

    expect(screen.getByText('emulator-5554')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('shows the resource meters once a sample has arrived', () => {
    render(
      emulator({
        ...running,
        usage: { cpuPercent: 12, memoryBytes: 1_932_735_283, cpuReady: true },
      }),
    );

    expect(screen.getByText('12%')).toBeInTheDocument();
    expect(screen.getByText('1.8 GB')).toBeInTheDocument();
  });

  it('says it is measuring rather than showing a misleading 0% on the first sample', () => {
    render(
      emulator({
        ...running,
        usage: { cpuPercent: 0, memoryBytes: 1_932_735_283, cpuReady: false },
      }),
    );

    // CPU is a delta between two samples on Windows and Linux, so the first tick has no rate.
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.getByText(/measuring/i)).toBeInTheDocument();
  });
});

describe('a physical device', () => {
  it('is marked as physical and has no Start or Stop', () => {
    render(physical('device'));

    expect(screen.getByText('Galaxy A52')).toBeInTheDocument();
    expect(screen.getByText('Physical')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('explains an unauthorized device and offers nothing destructive', () => {
    render(physical('unauthorized'));

    expect(screen.getByText(/USB debugging/i)).toBeInTheDocument();
    // A wall of disabled buttons reads as broken, so the actions are simply not there.
    expect(screen.queryByRole('button', { name: 'Screenshot' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /wipe/i })).not.toBeInTheDocument();
  });
});

describe('the action row', () => {
  it('appears on a running emulator with a label on every icon button', () => {
    render(emulator({ state: 'running', serial: 'emulator-5554', progress: 100 }));

    for (const label of ['Screenshot', 'Record screen', 'Rotate', 'Open shell', 'Install APK']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('appears on a ready physical device too', () => {
    render(physical('device'));

    expect(screen.getByRole('button', { name: 'Screenshot' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open shell' })).toBeInTheDocument();
  });

  it('passes the serial and a readable label to the handler', async () => {
    const { user } = render(emulator({ state: 'running', serial: 'emulator-5554', progress: 100 }));

    await user.click(screen.getByRole('button', { name: 'Screenshot' }));

    // The label names the capture file, so it is the display name, not the id.
    expect(actions.onScreenshot).toHaveBeenCalledWith('emulator-5554', 'Pixel 7 API 34');
  });

  it('shows the record button as armed while that device is recording', () => {
    renderWithProviders(
      <DeviceCard
        device={emulator({ state: 'running', serial: 'emulator-5554', progress: 100 })}
        pending={false}
        {...actions}
        recordingSerial="emulator-5554"
      />,
    );

    const stop = screen.getByRole('button', { name: 'Stop recording' });
    expect(stop).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the per-device menu', () => {
  it('offers Edit on a stopped device, alongside the rest', async () => {
    const { user } = render(emulator());

    await user.click(screen.getByRole('button', { name: /more actions/i }));

    for (const label of ['Edit', 'Cold boot', 'Wipe data', 'Delete']) {
      expect(await screen.findByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });

  it('opens the editor for the device it belongs to', async () => {
    const { user } = render(emulator());

    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    expect(actions.onEdit).toHaveBeenCalledWith('Pixel_7_API_34');
  });

  it('still offers Edit while the device runs, since the change lands on the next start', async () => {
    const { user } = render(emulator({ state: 'running', serial: 'emulator-5554', progress: 100 }));

    await user.click(screen.getByRole('button', { name: /more actions/i }));

    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeEnabled();
  });

  it('will not delete or wipe a device that is running', async () => {
    const { user } = render(emulator({ state: 'running', serial: 'emulator-5554', progress: 100 }));

    await user.click(screen.getByRole('button', { name: /more actions/i }));

    // Both need the AVD's folder to itself, so they are refused while it is in use.
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: 'Wipe data' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('gives a physical device no menu, since there is no AVD to edit', () => {
    render(physical('device'));

    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
  });
});
