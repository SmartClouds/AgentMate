import type { AndroidDevice, AvdSummary } from '@runova/core';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ApkDropZone } from './ApkDropZone';

/**
 * Dropping an APK. The two things that must not happen are a silent no-op on a file that cannot
 * be installed, and an install landing on a device the user did not pick.
 */

const AVD = { name: 'Pixel_7', displayName: 'Pixel 7' } as AvdSummary;

const running: AndroidDevice = {
  kind: 'emulator',
  avd: AVD,
  state: 'running',
  serial: 'emulator-5554',
  progress: 100,
  adopted: false,
  usage: null,
  lastLine: null,
  error: null,
};

const phone: AndroidDevice = {
  kind: 'physical',
  device: {
    serial: 'R58M20ABCDE',
    state: 'device',
    kind: 'usb',
    model: 'Galaxy A52',
    product: null,
    device: null,
    transportId: '5',
  },
  androidVersion: '14',
  api: 34,
};

function file(name: string): File {
  return new File(['x'], name, { type: 'application/vnd.android.package-archive' });
}

/** A DataTransfer jsdom will carry on a synthetic drag event. */
function transfer(files: File[]) {
  return { files, types: files.length > 0 ? ['Files'] : [] };
}

function setup(targets: AndroidDevice[]) {
  const onInstall = vi.fn();
  const onReject = vi.fn();
  const view = renderWithProviders(
    <ApkDropZone targets={targets} onInstall={onInstall} onReject={onReject}>
      <div data-testid="grid">grid</div>
    </ApkDropZone>,
    { bridge: { 'shell.pathForFile': (f: File) => `/tmp/${f.name}` } },
  );
  return {
    ...view,
    onInstall,
    onReject,
    zone: screen.getByTestId('grid').parentElement as Element,
  };
}

describe('ApkDropZone', () => {
  it('shows where the APK will go while a file is over it', () => {
    const { zone } = setup([running]);

    fireEvent.dragOver(zone, { dataTransfer: transfer([file('app.apk')]) });

    expect(screen.getByText('Install on Pixel 7')).toBeInTheDocument();
  });

  it('installs on the only device that is up', () => {
    const { zone, onInstall } = setup([running]);

    fireEvent.drop(zone, { dataTransfer: transfer([file('app-debug.apk')]) });

    expect(onInstall).toHaveBeenCalledWith('emulator-5554', 'Pixel 7', ['/tmp/app-debug.apk']);
  });

  it('asks which device when more than one is up, rather than guessing', () => {
    const { zone, onInstall, onReject } = setup([running, phone]);

    fireEvent.drop(zone, { dataTransfer: transfer([file('app.apk')]) });

    expect(onInstall).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith(expect.stringMatching(/device you want/i));
  });

  it('says so when the file is not an APK, rather than doing nothing', () => {
    const { zone, onInstall, onReject } = setup([running]);

    fireEvent.drop(zone, { dataTransfer: transfer([file('notes.txt')]) });

    expect(onInstall).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith(expect.stringMatching(/only \.apk/i));
  });

  it('says to start something when nothing is up', () => {
    const { zone, onReject } = setup([]);

    fireEvent.drop(zone, { dataTransfer: transfer([file('app.apk')]) });

    expect(onReject).toHaveBeenCalledWith(expect.stringMatching(/start an emulator|plug in/i));
  });

  it('does not arm the overlay for a drag that carries no files', () => {
    const { zone } = setup([running]);

    fireEvent.dragOver(zone, { dataTransfer: { files: [], types: ['text/plain'] } });

    expect(screen.queryByText(/Install on/)).not.toBeInTheDocument();
  });
});
