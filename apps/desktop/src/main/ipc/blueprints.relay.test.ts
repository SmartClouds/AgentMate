import type { ProjectBlueprint } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { invoke, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

const data = useTempUserData();

async function register(): Promise<void> {
  data.writeData('projects.json', [{ id: 'p1', name: 'Apollo', folderPath: data.dir }]);
  await loadIpc(
    () => import('./blueprints'),
    (module) => module.registerBlueprintHandlers(),
  );
}

describe('blueprints:setRelay', () => {
  it('starts with the Relay split off at the default budget', async () => {
    await register();
    const blueprint = await invoke<ProjectBlueprint>(IPC.blueprints.get, 'p1');
    expect(blueprint.relay).toEqual({ enabled: false, budgetTokens: 200_000 });
  });

  it('saves the switch and the budget', async () => {
    await register();
    const saved = await invoke<ProjectBlueprint>(IPC.blueprints.setRelay, 'p1', {
      enabled: true,
      budgetTokens: 400_000,
    });
    expect(saved.relay).toEqual({ enabled: true, budgetTokens: 400_000 });
    const again = await invoke<ProjectBlueprint>(IPC.blueprints.get, 'p1');
    expect(again.relay).toEqual({ enabled: true, budgetTokens: 400_000 });
  });

  it('refuses a value that is not a Relay setting', async () => {
    await register();
    await expect(
      invoke(IPC.blueprints.setRelay, 'p1', { enabled: 'yes', budgetTokens: 400_000 }),
    ).rejects.toThrow();
    await expect(
      invoke(IPC.blueprints.setRelay, 'p1', { enabled: true, budgetTokens: 5 }),
    ).rejects.toThrow();
  });
});
