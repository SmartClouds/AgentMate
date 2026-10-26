import { create } from 'zustand';

/**
 * Whether the About Runova dialog is showing. It lives in a store because the sidebar's about
 * card and the top menu's version chip both open it, while the dialog itself is mounted once.
 */
interface AboutState {
  open: boolean;
}

export const useAboutStore = create<AboutState>(() => ({ open: false }));

export function openAbout(): void {
  useAboutStore.setState({ open: true });
}

export function closeAbout(): void {
  useAboutStore.setState({ open: false });
}
