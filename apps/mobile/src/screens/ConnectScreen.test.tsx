import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { mockCamera } from '../../jest.setup';
import { fakeClient, fakeSavedDevice } from '../remote/__fixtures__/fakeClient';
import { ConnectScreen } from './ConnectScreen';

const PAIRING_CODE = 'RUNOVA1:eyJpcCI6IjE5Mi4xNjguMS4xMCJ9';

describe('ConnectScreen', () => {
  it('shows the pairing card on a fresh install', async () => {
    await render(<ConnectScreen client={fakeClient()} />);
    expect(screen.getByText('Runova')).toBeTruthy();
    expect(screen.getByText('Pair a new computer')).toBeTruthy();
    // Nothing paired yet, so the saved list is not there at all.
    expect(screen.queryByText('My computers')).toBeNull();
  });

  it('keeps Connect disabled until a code is entered', async () => {
    const client = fakeClient();
    await render(<ConnectScreen client={client} />);

    await fireEvent.press(screen.getByText('Connect'));
    expect(jest.mocked(client.connect)).not.toHaveBeenCalled();
  });

  it('connects with the typed code, trimmed', async () => {
    // Codes get pasted, and a pasted code usually drags whitespace with it.
    const client = fakeClient();
    await render(<ConnectScreen client={client} />);

    await fireEvent.changeText(screen.getByPlaceholderText('RUNOVA1:…'), `  ${PAIRING_CODE}\n`);
    await fireEvent.press(screen.getByText('Connect'));
    expect(jest.mocked(client.connect)).toHaveBeenCalledWith(PAIRING_CODE);
  });

  it('shows Connecting… and blocks a second attempt while dialing', async () => {
    const client = fakeClient({ status: 'connecting' });
    await render(<ConnectScreen client={client} />);

    await fireEvent.changeText(screen.getByPlaceholderText('RUNOVA1:…'), PAIRING_CODE);
    await fireEvent.press(screen.getByText('Connecting…'));
    expect(jest.mocked(client.connect)).not.toHaveBeenCalled();
  });

  it('shows the rejection reason under the code box when nothing is paired yet', async () => {
    const client = fakeClient({
      status: 'error',
      error: 'That pairing code is not valid.',
    });
    await render(<ConnectScreen client={client} />);
    expect(screen.getByText('That pairing code is not valid.')).toBeTruthy();
  });

  describe('saved computers', () => {
    it('lists each computer with its address and when it was last used', async () => {
      const client = fakeClient({
        savedDevices: [
          fakeSavedDevice({ id: 'a', label: 'Studio PC' }),
          fakeSavedDevice({
            id: 'b',
            label: 'Laptop',
            ip: '192.168.1.90',
            port: 51001,
            lastConnectedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
          }),
        ],
      });
      await render(<ConnectScreen client={client} />);

      expect(screen.getByText('My computers')).toBeTruthy();
      expect(screen.getByText('Studio PC')).toBeTruthy();
      expect(screen.getByText('192.168.1.44:51000 · today')).toBeTruthy();
      expect(screen.getByText('192.168.1.90:51001 · 2 days ago')).toBeTruthy();
    });

    it('says yesterday for a day-old connection', async () => {
      const client = fakeClient({
        savedDevices: [
          fakeSavedDevice({ lastConnectedAt: Date.now() - 24 * 60 * 60 * 1000 - 1000 }),
        ],
      });
      await render(<ConnectScreen client={client} />);
      expect(screen.getByText('192.168.1.44:51000 · yesterday')).toBeTruthy();
    });

    it('reconnects with one tap on a row', async () => {
      const device = fakeSavedDevice();
      const client = fakeClient({ savedDevices: [device] });
      await render(<ConnectScreen client={client} />);

      await fireEvent.press(screen.getByText('Studio PC'));
      expect(jest.mocked(client.connectToSaved)).toHaveBeenCalledWith(device);
    });

    it('does not reconnect while another connection is being dialed', async () => {
      const client = fakeClient({ status: 'connecting', savedDevices: [fakeSavedDevice()] });
      await render(<ConnectScreen client={client} />);

      await fireEvent.press(screen.getByText('Studio PC'));
      expect(jest.mocked(client.connectToSaved)).not.toHaveBeenCalled();
    });

    it('shows the rejection reason inside the saved list', async () => {
      // With saved computers on screen the error belongs next to them, because
      // a stale token is the likely cause rather than a mistyped code.
      const client = fakeClient({
        status: 'error',
        error: 'Unknown device.',
        savedDevices: [fakeSavedDevice()],
      });
      await render(<ConnectScreen client={client} />);
      expect(screen.getAllByText('Unknown device.')).toHaveLength(1);
    });

    it('renames a computer from the edit sheet', async () => {
      const client = fakeClient({ savedDevices: [fakeSavedDevice()] });
      await render(<ConnectScreen client={client} />);

      await fireEvent.press(screen.getByText('✎'));
      // The sheet opens prefilled, so a rename is an edit and not a retype.
      const input = screen.getByDisplayValue('Studio PC');
      await fireEvent.changeText(input, 'Living room');
      await fireEvent.press(screen.getByText('Save'));

      expect(jest.mocked(client.renameDevice)).toHaveBeenCalledWith('dev-1', 'Living room');
      expect(screen.queryByText('Computer name')).toBeNull();
    });

    it('refuses to save an empty name', async () => {
      const client = fakeClient({ savedDevices: [fakeSavedDevice()] });
      await render(<ConnectScreen client={client} />);

      await fireEvent.press(screen.getByText('✎'));
      await fireEvent.changeText(screen.getByDisplayValue('Studio PC'), '   ');
      await fireEvent.press(screen.getByText('Save'));
      expect(jest.mocked(client.renameDevice)).not.toHaveBeenCalled();
    });

    it('forgets a computer from the edit sheet', async () => {
      const client = fakeClient({ savedDevices: [fakeSavedDevice()] });
      await render(<ConnectScreen client={client} />);

      await fireEvent.press(screen.getByText('✎'));
      await fireEvent.press(screen.getByText('Forget'));
      expect(jest.mocked(client.removeDevice)).toHaveBeenCalledWith('dev-1');
      expect(screen.queryByText('Computer name')).toBeNull();
    });

    it('closes the edit sheet without touching anything on Cancel', async () => {
      const client = fakeClient({ savedDevices: [fakeSavedDevice()] });
      await render(<ConnectScreen client={client} />);

      await fireEvent.press(screen.getByText('✎'));
      await fireEvent.changeText(screen.getByDisplayValue('Studio PC'), 'Living room');
      await fireEvent.press(screen.getByText('Cancel'));

      expect(jest.mocked(client.renameDevice)).not.toHaveBeenCalled();
      expect(jest.mocked(client.removeDevice)).not.toHaveBeenCalled();
      expect(screen.queryByText('Computer name')).toBeNull();
    });
  });

  describe('QR scanning', () => {
    it('opens the scanner and connects with what it read', async () => {
      const client = fakeClient();
      await render(<ConnectScreen client={client} />);
      expect(screen.queryByTestId('camera-view')).toBeNull();

      await fireEvent.press(screen.getByText('Scan QR'));
      expect(screen.getByTestId('camera-view')).toBeTruthy();
    });

    it('connects with a scanned code and closes the scanner', async () => {
      const client = fakeClient();
      await render(<ConnectScreen client={client} />);
      await fireEvent.press(screen.getByText('Scan QR'));

      const onBarcodeScanned = mockCamera.lastProps?.onBarcodeScanned as
        | ((result: { data: string }) => void)
        | undefined;
      await act(async () => {
        onBarcodeScanned?.({ data: PAIRING_CODE });
      });

      expect(jest.mocked(client.connect)).toHaveBeenCalledWith(PAIRING_CODE);
      expect(screen.queryByTestId('camera-view')).toBeNull();
      // The scanned code stays in the box so a failed pair can be retried.
      expect(screen.getByDisplayValue(PAIRING_CODE)).toBeTruthy();
    });

    it('closes the scanner again', async () => {
      await render(<ConnectScreen client={fakeClient()} />);
      await fireEvent.press(screen.getByText('Scan QR'));
      await fireEvent.press(screen.getByText('Close'));
      expect(screen.queryByTestId('camera-view')).toBeNull();
    });
  });
});
