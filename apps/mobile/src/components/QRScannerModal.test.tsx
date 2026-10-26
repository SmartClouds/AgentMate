import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { mockCamera } from '../../jest.setup';
import { QRScannerModal } from './QRScannerModal';

type BarcodeHandler = (result: { data: string }) => void;

/** The handler expo-camera would call on a decoded frame. */
function scanHandler(): BarcodeHandler {
  const handler = mockCamera.lastProps?.onBarcodeScanned;
  if (typeof handler !== 'function') throw new Error('the camera was never rendered');
  return handler as BarcodeHandler;
}

describe('QRScannerModal', () => {
  afterEach(() => {
    mockCamera.request = async () => ({ granted: true });
  });

  it('renders nothing while closed', async () => {
    await render(<QRScannerModal visible={false} onClose={jest.fn()} onScanned={jest.fn()} />);
    expect(screen.queryByTestId('camera-view')).toBeNull();
    expect(screen.queryByText('Enable camera')).toBeNull();
  });

  it('asks for camera access when permission was denied', async () => {
    mockCamera.permission = { granted: false };
    const request = jest.fn(async () => ({ granted: true }));
    mockCamera.request = request;

    await render(<QRScannerModal visible onClose={jest.fn()} onScanned={jest.fn()} />);
    expect(screen.queryByTestId('camera-view')).toBeNull();
    expect(
      screen.getByText(
        'Runova needs camera access to scan the pairing QR code shown on the desktop app.',
      ),
    ).toBeTruthy();

    await fireEvent.press(screen.getByText('Enable camera'));
    expect(request).toHaveBeenCalled();
  });

  it('asks for camera access while the permission is still unknown', async () => {
    // The hook reports null on the very first render; treating that as granted
    // would mount the camera before the OS prompt has been answered.
    mockCamera.permission = null;
    await render(<QRScannerModal visible onClose={jest.fn()} onScanned={jest.fn()} />);
    expect(screen.getByText('Enable camera')).toBeTruthy();
  });

  it('scans QR codes only and reports the decoded payload', async () => {
    const onScanned = jest.fn();
    await render(<QRScannerModal visible onClose={jest.fn()} onScanned={onScanned} />);
    expect(screen.getByTestId('camera-view')).toBeTruthy();
    expect(mockCamera.lastProps?.barcodeScannerSettings).toEqual({ barcodeTypes: ['qr'] });

    await act(async () => {
      scanHandler()({ data: 'RUNOVA1:payload' });
    });
    expect(onScanned).toHaveBeenCalledWith('RUNOVA1:payload');
  });

  it('ignores every frame after the first hit', async () => {
    // The camera fires onBarcodeScanned for every frame the code is visible, so
    // without the latch one QR in view would dial the host dozens of times.
    const onScanned = jest.fn();
    await render(<QRScannerModal visible onClose={jest.fn()} onScanned={onScanned} />);

    await act(async () => {
      scanHandler()({ data: 'RUNOVA1:payload' });
      scanHandler()({ data: 'RUNOVA1:payload' });
      scanHandler()({ data: 'RUNOVA1:other' });
    });
    expect(onScanned).toHaveBeenCalledTimes(1);
  });

  it('closes on the Close button', async () => {
    const onClose = jest.fn();
    await render(<QRScannerModal visible onClose={onClose} onScanned={jest.fn()} />);
    await fireEvent.press(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});
