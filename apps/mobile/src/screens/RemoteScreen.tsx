import { formatBytes } from '@runova/protocol';
import { useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RemoteViewport } from '../components/RemoteViewport';
import { Toolbar } from '../components/Toolbar';
import { PHASE_LABELS, RemoteTransportMode } from '../remote/transport';
import type { useRemoteClient } from '../remote/useRemoteClient';
import { colors, radius, spacing } from '../theme';

type RemoteClient = ReturnType<typeof useRemoteClient>;

/**
 * The active-session screen. The host's display gets the entire phone screen;
 * the header is a translucent overlay toggled by the ⋯ button so it never
 * steals space from the remote desktop, and the key toolbar sits inside the
 * bottom safe-area inset so Android's navigation bar can't cover it.
 */
export function RemoteScreen({ client }: { client: RemoteClient }): React.JSX.Element {
  const {
    status,
    remoteDeviceName,
    remoteScreen,
    tiles,
    transport,
    phase,
    remoteStream,
    stats,
    sendInput,
    sendClipboardToHost,
    disconnect,
    retryVideo,
  } = client;
  const connected = status === 'connected';
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showStats, setShowStats] = useState(false);

  const onFallback = transport === RemoteTransportMode.JPEG_TILE_FALLBACK;
  const waitingForVideo = connected && !onFallback && !remoteStream && tiles.size === 0;

  return (
    <View style={styles.root}>
      <StatusBar hidden />

      <RemoteViewport
        screen={remoteScreen}
        stream={remoteStream}
        tiles={tiles}
        transport={transport}
        live={connected}
        onInput={sendInput}
      />

      {(!connected || waitingForVideo) && (
        <View style={styles.centerOverlay} pointerEvents="none">
          <Text style={styles.centerOverlayText}>
            {connected ? `Starting video: ${PHASE_LABELS[phase]}` : 'Connecting…'}
          </Text>
        </View>
      )}

      {/* Floating menu toggle, the only permanent chrome over the screen. */}
      <Pressable
        style={[
          styles.menuButton,
          { top: insets.top + spacing(2), right: insets.right + spacing(2) },
        ]}
        onPress={() => setMenuOpen((open) => !open)}
        hitSlop={8}
      >
        <Text style={styles.menuButtonText}>⋯</Text>
      </Pressable>

      {menuOpen && (
        <View
          style={[
            styles.header,
            { top: insets.top + spacing(2), right: insets.right + spacing(12) },
          ]}
        >
          <View style={styles.headerLeft}>
            <View
              style={[styles.dot, { backgroundColor: connected ? colors.success : colors.warning }]}
            />
            <Text style={styles.deviceName} numberOfLines={1}>
              {remoteDeviceName ?? 'Remote device'}
            </Text>
            {remoteScreen && (
              <Text style={styles.resolution}>
                {remoteScreen.width}×{remoteScreen.height}
                {onFallback ? ' · compat' : ''}
              </Text>
            )}
          </View>
          <Pressable
            style={[styles.headerButton, showStats && styles.headerButtonActive]}
            onPress={() => setShowStats((s) => !s)}
          >
            <Text style={styles.headerButtonText}>Stats</Text>
          </Pressable>
          <Pressable
            style={styles.headerButton}
            onPress={() => void sendClipboardToHost()}
            disabled={!connected}
          >
            <Text style={styles.headerButtonText}>Clipboard</Text>
          </Pressable>
          <Pressable
            style={[styles.headerButton, styles.disconnectButton]}
            onPress={() => disconnect('user disconnected')}
          >
            <Text style={styles.disconnectButtonText}>Disconnect</Text>
          </Pressable>
        </View>
      )}

      {showStats && stats && (
        <View
          style={[
            styles.statsOverlay,
            { top: insets.top + spacing(2), left: insets.left + spacing(2) },
          ]}
        >
          <Text style={[styles.statsText, styles.statsHeading]}>
            {stats.transport === RemoteTransportMode.WEBRTC_VIDEO
              ? `WEBRTC_VIDEO · ${stats.codec ?? '…'}`
              : 'JPEG_TILE_FALLBACK'}
          </Text>
          <Text style={styles.statsText}>phase: {PHASE_LABELS[stats.phase]}</Text>
          {stats.connectionState && (
            <Text style={styles.statsText}>
              pc: {stats.connectionState} · ice: {stats.iceConnectionState ?? 'n/a'}
            </Text>
          )}
          {stats.width > 0 && (
            <Text style={styles.statsText}>
              {stats.width}×{stats.height} @ {stats.fps} fps
            </Text>
          )}
          <Text style={styles.statsText}>
            {stats.kbps >= 1000 ? `${(stats.kbps / 1000).toFixed(1)} Mbps` : `${stats.kbps} kbps`}
          </Text>
          <Text style={styles.statsText}>{formatBytes(stats.totalBytes)} received</Text>
          {stats.rttMs !== null && <Text style={styles.statsText}>ping {stats.rttMs} ms</Text>}
          {stats.transport === RemoteTransportMode.WEBRTC_VIDEO && (
            <Text style={styles.statsText}>
              lost {stats.packetsLost} · dropped {stats.framesDropped}
              {stats.jitterMs !== null ? ` · jitter ${stats.jitterMs} ms` : ''}
            </Text>
          )}
          {onFallback && (
            <Pressable style={styles.retryButton} onPress={retryVideo}>
              <Text style={styles.retryButtonText}>Retry video</Text>
            </Pressable>
          )}
        </View>
      )}

      <Toolbar live={connected} onInput={sendInput} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  centerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerOverlayText: {
    color: colors.mutedForeground,
    fontSize: 14,
    fontWeight: '600',
  },
  menuButton: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(20, 20, 20, 0.75)',
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuButtonText: {
    color: colors.foreground,
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 20,
  },
  header: {
    position: 'absolute',
    left: spacing(2),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(2),
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(20, 20, 20, 0.92)',
    gap: spacing(2),
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    flexShrink: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  deviceName: {
    color: colors.foreground,
    fontWeight: '600',
    fontSize: 14,
    flexShrink: 1,
  },
  resolution: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
  headerButton: {
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(1.5),
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
  },
  headerButtonText: {
    color: colors.foreground,
    fontSize: 12,
    fontWeight: '600',
  },
  headerButtonActive: {
    backgroundColor: colors.accent,
  },
  statsOverlay: {
    position: 'absolute',
    backgroundColor: 'rgba(10, 10, 10, 0.7)',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing(2.5),
    paddingVertical: spacing(1.5),
    gap: 2,
  },
  statsText: {
    color: colors.foreground,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  statsHeading: {
    fontWeight: '700',
  },
  retryButton: {
    marginTop: spacing(1),
    paddingHorizontal: spacing(2),
    paddingVertical: spacing(1),
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
    alignSelf: 'flex-start',
  },
  retryButtonText: {
    color: colors.foreground,
    fontSize: 11,
    fontWeight: '600',
  },
  disconnectButton: {
    backgroundColor: colors.destructive,
  },
  disconnectButtonText: {
    color: colors.destructiveForeground,
    fontSize: 12,
    fontWeight: '600',
  },
});
