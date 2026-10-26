import { useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { QRScannerModal } from '../components/QRScannerModal';
import type { SavedDevice } from '../remote/savedDevices';
import type { useRemoteClient } from '../remote/useRemoteClient';
import { colors, radius, spacing } from '../theme';

type RemoteClient = ReturnType<typeof useRemoteClient>;

function lastConnectedLabel(at: number): string {
  const days = Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export function ConnectScreen({ client }: { client: RemoteClient }): React.JSX.Element {
  const { status, error, connect, connectToSaved, savedDevices, renameDevice, removeDevice } =
    client;
  const [code, setCode] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [editing, setEditing] = useState<SavedDevice | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const connecting = status === 'connecting';

  const handleScanned = (data: string) => {
    setScannerOpen(false);
    setCode(data);
    connect(data);
  };

  const openEditor = (device: SavedDevice) => {
    setEditing(device);
    setEditLabel(device.label);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.hero}>
            <Image
              // biome-ignore lint/style/noCommonJs: RN's bundler resolves static image assets via require()
              source={require('../../assets/splash-icon.png')}
              style={styles.logo}
              resizeMode="contain"
            />
            <Text style={styles.title}>Runova</Text>
            <Text style={styles.subtitle}>Remote Control</Text>
          </View>

          {savedDevices.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.label}>My computers</Text>
              {savedDevices.map((device) => (
                <View key={device.id} style={styles.deviceRow}>
                  <Pressable
                    style={styles.deviceMain}
                    disabled={connecting}
                    onPress={() => connectToSaved(device)}
                  >
                    <Text style={styles.deviceLabel} numberOfLines={1}>
                      {device.label}
                    </Text>
                    <Text style={styles.deviceMeta} numberOfLines={1}>
                      {device.ip}:{device.port} · {lastConnectedLabel(device.lastConnectedAt)}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.deviceEdit}
                    onPress={() => openEditor(device)}
                    hitSlop={6}
                  >
                    <Text style={styles.deviceEditText}>✎</Text>
                  </Pressable>
                </View>
              ))}
              {status === 'error' && error && <Text style={styles.errorText}>{error}</Text>}
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.label}>Pair a new computer</Text>
            <TextInput
              value={code}
              onChangeText={setCode}
              placeholder="RUNOVA1:…"
              placeholderTextColor={colors.mutedForeground}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.codeInput}
            />

            {savedDevices.length === 0 && status === 'error' && error && (
              <Text style={styles.errorText}>{error}</Text>
            )}

            <View style={styles.buttonRow}>
              <Pressable style={styles.secondaryButton} onPress={() => setScannerOpen(true)}>
                <Text style={styles.secondaryButtonText}>Scan QR</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.primaryButton,
                  (!code.trim() || connecting) && styles.buttonDisabled,
                ]}
                disabled={!code.trim() || connecting}
                onPress={() => connect(code.trim())}
              >
                <Text style={styles.primaryButtonText}>
                  {connecting ? 'Connecting…' : 'Connect'}
                </Text>
              </Pressable>
            </View>
          </View>

          <Text style={styles.hint}>
            On the computer you want to control, open Runova → Remote → Host tab, then start hosting
            and share its pairing code or QR here. You only pair once; the computer is saved above
            for future connections.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      <QRScannerModal
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScanned={handleScanned}
      />

      <Modal
        visible={editing !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.label}>Computer name</Text>
            <TextInput
              value={editLabel}
              onChangeText={setEditLabel}
              autoFocus
              style={styles.editInput}
              placeholderTextColor={colors.mutedForeground}
            />
            <View style={styles.buttonRow}>
              <Pressable
                style={styles.dangerButton}
                onPress={() => {
                  if (editing) void removeDevice(editing.id);
                  setEditing(null);
                }}
              >
                <Text style={styles.dangerButtonText}>Forget</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => setEditing(null)}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryButton, !editLabel.trim() && styles.buttonDisabled]}
                disabled={!editLabel.trim()}
                onPress={() => {
                  if (editing) void renameDevice(editing.id, editLabel);
                  setEditing(null);
                }}
              >
                <Text style={styles.primaryButtonText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    padding: spacing(6),
    justifyContent: 'center',
    gap: spacing(6),
  },
  hero: {
    alignItems: 'center',
    gap: spacing(1),
  },
  logo: {
    width: 96,
    height: 96,
    marginBottom: spacing(2),
  },
  title: {
    color: colors.foreground,
    fontSize: 26,
    fontWeight: '800',
  },
  subtitle: {
    color: colors.mutedForeground,
    fontSize: 14,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing(4),
    gap: spacing(3),
  },
  label: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2.5),
  },
  deviceMain: {
    flex: 1,
    gap: 2,
  },
  deviceLabel: {
    color: colors.foreground,
    fontSize: 15,
    fontWeight: '700',
  },
  deviceMeta: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
  deviceEdit: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceEditText: {
    color: colors.foreground,
    fontSize: 15,
  },
  codeInput: {
    minHeight: 96,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    color: colors.foreground,
    padding: spacing(3),
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 13,
    textAlignVertical: 'top',
  },
  editInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    color: colors.foreground,
    padding: spacing(3),
    fontSize: 15,
  },
  errorText: {
    color: colors.destructive,
    fontSize: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing(3),
  },
  secondaryButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing(3),
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
  },
  secondaryButtonText: {
    color: colors.foreground,
    fontWeight: '700',
  },
  primaryButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing(3),
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    color: colors.primaryForeground,
    fontWeight: '700',
  },
  dangerButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing(3),
    borderRadius: radius.md,
    backgroundColor: colors.destructive,
  },
  dangerButtonText: {
    color: colors.destructiveForeground,
    fontWeight: '700',
  },
  hint: {
    color: colors.mutedForeground,
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing(6),
  },
  modalCard: {
    alignSelf: 'stretch',
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing(4),
    gap: spacing(3),
  },
});
