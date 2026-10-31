import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipcChannels';
import type {
  NewsChangedEvent,
  NewsItemDetailView,
  NewsListQuery,
  NewsListResult,
} from '../shared/newsTypes';

/**
 * News from runovahq.com (E42), served from the main process's cache. Nothing here reaches the
 * network on its own; main polls, and `refresh` asks it to now.
 */
export function createNews() {
  return {
    list: (query?: NewsListQuery): Promise<NewsListResult> =>
      ipcRenderer.invoke(IPC.news.list, query),
    get: (slug: string): Promise<NewsItemDetailView | null> =>
      ipcRenderer.invoke(IPC.news.get, { slug }),
    refresh: (): Promise<NewsListResult> => ipcRenderer.invoke(IPC.news.refresh),
    markRead: (id: number): Promise<void> => ipcRenderer.invoke(IPC.news.markRead, { id }),
    dismiss: (id: number): Promise<void> => ipcRenderer.invoke(IPC.news.dismiss, { id }),
    onChanged: (callback: (event: NewsChangedEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: NewsChangedEvent): void =>
        callback(payload);
      ipcRenderer.on(IPC.news.onChanged, listener);
      return () => ipcRenderer.removeListener(IPC.news.onChanged, listener);
    },
  };
}
