import type { UpdateStatus } from '@shared/apiTypes';
import { create } from 'zustand';

interface UpdateState {
  status: UpdateStatus;
  dialogOpen: boolean;
}

export const useUpdateStore = create<UpdateState>(() => ({
  status: { state: 'idle' },
  dialogOpen: false,
}));

export function openUpdateDialog(): void {
  useUpdateStore.setState({ dialogOpen: true });
}

export function closeUpdateDialog(): void {
  useUpdateStore.setState({ dialogOpen: false });
}

/** Subscribes to main-process update-status pushes; call once near the app root. */
export function initUpdateStatusListener(): () => void {
  return window.runova.app.onUpdateStatus((status) => {
    useUpdateStore.setState({ status });
  });
}
