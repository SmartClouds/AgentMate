import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The panel widths used to live under four keys of their own. The store reads them when its own
 * key is empty, so a panel someone resized keeps its size after the move.
 */

async function freshStore(): Promise<typeof import('./panelWidthStore')> {
  vi.resetModules();
  return import('./panelWidthStore');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('panelWidthStore', () => {
  it('starts every panel at its default', async () => {
    const { PANEL_WIDTHS, usePanelWidthStore } = await freshStore();
    expect(usePanelWidthStore.getState().widths).toEqual({});
    expect(PANEL_WIDTHS.deployRail.default).toBe(256);
  });

  it('picks up the widths saved under the old keys', async () => {
    localStorage.setItem('runova-deploy-rail', JSON.stringify({ state: { width: 300 } }));
    localStorage.setItem('runova-cloudflare-rail', JSON.stringify({ state: { width: 310 } }));
    localStorage.setItem(
      'runova-catalog-layout',
      JSON.stringify({ state: { widths: { mcpRepositories: 280, unknownPanel: 999 } } }),
    );
    localStorage.setItem(
      'runova-pane-layout',
      JSON.stringify({ state: { widths: { vaultList: 400, remoteFilesPlaces: 250 } } }),
    );

    const { usePanelWidthStore } = await freshStore();
    expect(usePanelWidthStore.getState().widths).toEqual({
      deployRail: 300,
      cloudflareRail: 310,
      mcpRepositories: 280,
      vaultList: 400,
      remoteFilesPlaces: 250,
    });
  });

  it('prefers its own key over the old ones once it has saved', async () => {
    localStorage.setItem('runova-deploy-rail', JSON.stringify({ state: { width: 300 } }));
    localStorage.setItem(
      'runova-panel-widths',
      JSON.stringify({ state: { widths: { deployRail: 220 } }, version: 0 }),
    );

    const { usePanelWidthStore } = await freshStore();
    expect(usePanelWidthStore.getState().widths).toEqual({ deployRail: 220 });
  });

  it('saves a resize under its own key', async () => {
    const { usePanelWidthStore } = await freshStore();
    usePanelWidthStore.getState().setWidth('pipelinesFilters', 300);
    const saved = JSON.parse(localStorage.getItem('runova-panel-widths') ?? '{}');
    expect(saved.state.widths).toEqual({ pipelinesFilters: 300 });
  });

  it('skips an old value that no longer parses', async () => {
    localStorage.setItem('runova-deploy-rail', '{not json');
    localStorage.setItem('runova-cloudflare-rail', JSON.stringify({ state: { width: 310 } }));
    const { usePanelWidthStore } = await freshStore();
    expect(usePanelWidthStore.getState().widths).toEqual({ cloudflareRail: 310 });
  });
});
