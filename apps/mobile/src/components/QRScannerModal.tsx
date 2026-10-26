import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';

interface QRScannerModalProps {
  visible: boolean;
  onClose: () => void;
  onScanned: (data: string) => void;
}

export function QRScannerModal({
  visible,
  onClose,
  onScanned,
}: QRScannerModalProps): React.JSX.Element {
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  if (visible) handled.current = false;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={(result) => {
              if (handled.current) return;
              handled.current = true;
              onScanned(result.data);
            }}
          />
        ) : (
          <View style={styles.permissionBox}>
            <Text style={styles.permissionText}>
              Runova needs camera access to scan the pairing QR code shown on the desktop app.
            </Text>
            <Pressable style={styles.permissionButton} onPress={() => void requestPermission()}>
              <Text style={styles.permissionButtonText}>Enable camera</Text>
            </Pressable>
          </View>
        )}

        <View style={styles.frame} pointerEvents="none" />

        <Pressable style={styles.closeButton} onPress={onClose}>
          <Text style={styles.closeButtonText}>Close</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const FRAME_SIZE = 240;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    position: 'absolute',
    width: FRAME_SIZE,
    height: FRAME_SIZE,
    borderWidth: 2,
    borderColor: colors.primary,
    borderRadius: radius.lg,
  },
  closeButton: {
    position: 'absolute',
    top: spacing(14),
    right: spacing(5),
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(2),
    borderRadius: radius.md,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  closeButtonText: {
    color: colors.foreground,
    fontWeight: '600',
  },
  permissionBox: {
    padding: spacing(6),
    alignItems: 'center',
    gap: spacing(4),
  },
  permissionText: {
    color: colors.mutedForeground,
    textAlign: 'center',
    fontSize: 14,
  },
  permissionButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing(5),
    paddingVertical: spacing(3),
    borderRadius: radius.md,
  },
  permissionButtonText: {
    color: colors.primaryForeground,
    fontWeight: '700',
  },
});
