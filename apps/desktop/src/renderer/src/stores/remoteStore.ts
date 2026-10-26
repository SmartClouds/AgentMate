import type { RemoteFileProgress, RemoteLogEvent, RemoteState } from '@shared/apiTypes';
import { toast } from 'sonner';
import { create } from 'zustand';
import { initRtcController, requestRemoteVideo, teardownRemoteVideo } from '@/lib/rtcController';
import { closeAllRtcPeers, initRtcHost } from '@/lib/rtcHost';
import {
  forceFullFrame,
  setTilesEnabled,
  startScreenCapture,
  stopScreenCapture,
} from '@/lib/screenCapture';

const MAX_LOGS = 100;

/**
 * The main window and the standalone remote-session window (`#/remote-session`,
 * see `sessionWindow.ts` in main) each run their own copy of this renderer
 * bundle, so `initRemote()` runs in both. Controller-role video negotiation
 * must only ever happen in one of them, since both reacting to the same broadcast
 * `onState`/`onClientRtcSignal` events would open two independent WebRTC
 * negotiations over the single main-process-owned control socket. The session
 * window is the only place `RemoteScreen` mounts, so it's the only place that
 * should drive the controller side.
 */
function isRemoteSessionWindow(): boolean {
  return window.location.hash.startsWith('#/remote-session');
}

interface RemoteStore {
  state: RemoteState | null;
  logs: RemoteLogEvent[];
  transfers: RemoteFileProgress[];
  initialized: boolean;
  refresh: () => Promise<void>;
}

/**
 * Controller role: ask for the video track as soon as the control channel is
 * up, and drop the peer connection when it goes away. Only the session window
 * does this (see isRemoteSessionWindow's doc comment above). Must run on
 * *every* state update the session window sees, not just ones that arrive via
 * the `onState` push. The window's very first snapshot (fetched by
 * `refresh()` on mount) can already read 'connected' if the WebSocket beat
 * the window's own load/mount race, and that transition needs to trigger a
 * request too or the session is stuck on the JPEG-tile fallback forever.
 */
function syncControllerVideo(
  status: RemoteState['connection']['status'],
  previous?: RemoteState['connection']['status'],
): void {
  if (!isRemoteSessionWindow()) return;
  if (status === 'connected' && previous !== 'connected') requestRemoteVideo();
  else if (status !== 'connected' && previous === 'connected') teardownRemoteVideo();
}

export const useRemoteStore = create<RemoteStore>((set, get) => ({
  state: null,
  logs: [],
  transfers: [],
  initialized: false,
  refresh: async () => {
    const state = await window.runova.remote.getState();
    const previous = get().state?.connection.status;
    set({ state });
    syncControllerVideo(state.connection.status, previous);
  },
}));

/**
 * Wires the renderer to the main-process remote manager exactly once. Kept
 * outside any component so screen capture keeps running while hosting even when
 * the operator leaves the Remote page.
 */
export function initRemote(): void {
  if (useRemoteStore.getState().initialized) return;
  useRemoteStore.setState({ initialized: true });

  const api = window.runova.remote;

  api.onState((state) => {
    const previous = useRemoteStore.getState().state?.connection.status;
    useRemoteStore.setState({ state });
    syncControllerVideo(state.connection.status, previous);
  });

  api.onLog((event) => {
    useRemoteStore.setState((s) => ({ logs: [event, ...s.logs].slice(0, MAX_LOGS) }));
  });

  api.onFileProgress((progress) => {
    useRemoteStore.setState((s) => {
      const rest = s.transfers.filter((t) => t.transferId !== progress.transferId);
      return { transfers: [progress, ...rest].slice(0, 20) };
    });
    if (progress.done && !progress.error && progress.direction === 'incoming') {
      toast.success(`Received "${progress.name}"`);
    }
    if (progress.error) toast.error(`Transfer failed: ${progress.error}`);
  });

  // Host side: main tells us when a controller wants (or no longer wants) our screen.
  api.onCaptureStart(() => {
    void startScreenCapture().catch((err: unknown) => {
      toast.error(`Screen capture failed: ${(err as Error).message}`);
    });
  });
  api.onCaptureStop(() => {
    closeAllRtcPeers();
    void stopScreenCapture();
  });
  api.onCaptureRefresh(() => forceFullFrame());
  api.onTileDemand((demand) => setTilesEnabled(demand));

  // Host side: WebRTC signaling relay for controllers streaming video. Must
  // keep running in every window (hosting survives navigating off the page).
  initRtcHost();
  // Controller side: receives the host's video track (desktop-to-desktop).
  // Session-window-only. See isRemoteSessionWindow's doc comment above.
  if (isRemoteSessionWindow()) initRtcController();

  void useRemoteStore.getState().refresh();
}
