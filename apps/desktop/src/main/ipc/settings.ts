import type { AppSettings } from '@runova/core';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { clearGrammarCache } from '../grammar/languageToolClient';
import { stopLocalServer } from '../grammar/localServer';
import { applyProxySettings } from '../network/proxy';
import { applyNewsSettings } from '../news/runtime';
import { petManager } from '../pet/petWindow';
import { store } from '../store';
import { getVaultService } from '../vault';
import { applyWindowTheme } from '../windowGlass';

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC.settings.get, (): Promise<AppSettings> => store.getSettings());

  ipcMain.handle(
    IPC.settings.update,
    async (_event, updates: Partial<AppSettings>): Promise<AppSettings> => {
      let current: AppSettings | undefined;
      const next = await store.updateSettings((settings) => {
        current = settings;
        return { ...settings, ...updates };
      });
      void petManager.syncFromSettings();
      // Retints the window's Mica right away instead of on the next launch.
      if (updates.theme) applyWindowTheme(next.theme);
      if (Object.keys(updates).some((key) => key.startsWith('vault'))) {
        getVaultService().applySettings(next);
      }
      // News off stops the poll schedule right away, and on starts it again.
      if ('newsEnabled' in updates) applyNewsSettings(next);

      // Waited on rather than fired off, so the settings call only resolves
      // once the new route is the one the next request will take.
      if (updates.proxy) await applyProxySettings(next.proxy);

      // Cached check results are keyed by the settings they were produced with,
      // but the port or the picky level changing means the running server is the
      // wrong one to keep holding, so both are released here.
      if (updates.grammar) {
        clearGrammarCache();
        const before = (current ?? next).grammar;
        const wasLocal = before.source === 'local';
        const stillLocalOnSamePort =
          next.grammar.source === 'local' && next.grammar.localPort === before.localPort;
        if (wasLocal && !stillLocalOnSamePort) await stopLocalServer(before);
      }
      return next;
    },
  );
}
