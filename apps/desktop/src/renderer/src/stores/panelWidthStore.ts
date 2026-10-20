import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

/**
 * The widths of the resizable side panels (the Deploy and Cloudflare rails, the catalog
 * sidebars and the list panes laid out like the API Client), remembered between visits. Each
 * panel has its own entry and bounds.
 */

const CATALOG_SIDEBAR = { min: 180, max: 420, default: 240 } as const;

export const PANEL_WIDTHS = {
  deployRail: { min: 200, max: 380, default: 256 },
  cloudflareRail: { min: 200, max: 420, default: 260 },
  mcpRepositories: CATALOG_SIDEBAR,
  skillRepositories: CATALOG_SIDEBAR,
  vaultList: { min: 260, max: 520, default: 340 },
  pipelinesFilters: { min: 196, max: 360, default: 232 },
  remoteFilesPlaces: { min: 180, max: 360, default: 220 },
  sftpLocalPane: { min: 260, max: 1200, default: 520 },
} as const;

export type PanelId = keyof typeof PANEL_WIDTHS;

const STORAGE_KEY = 'agentmate-panel-widths';

/**
 * Where the widths were kept before they shared one store. A rail kept a single `width`, a
 * group of panels kept a `widths` map keyed the same way the new store is.
 */
const LEGACY_KEYS: ReadonlyArray<{ key: string; panel?: PanelId }> = [
  { key: 'agentmate-deploy-rail', panel: 'deployRail' },
  { key: 'agentmate-cloudflare-rail', panel: 'cloudflareRail' },
  { key: 'agentmate-catalog-layout' },
  { key: 'agentmate-pane-layout' },
];

function isPanelId(value: string): value is PanelId {
  return Object.hasOwn(PANEL_WIDTHS, value);
}

/** The widths saved under the old keys, so a resized panel keeps its size after the move. */
function legacyWidths(): Partial<Record<PanelId, number>> {
  const widths: Partial<Record<PanelId, number>> = {};
  for (const { key, panel } of LEGACY_KEYS) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const state = (JSON.parse(raw) as { state?: Record<string, unknown> }).state ?? {};
      if (panel) {
        if (typeof state.width === 'number') widths[panel] = state.width;
        continue;
      }
      const saved = state.widths;
      if (!saved || typeof saved !== 'object') continue;
      for (const [id, width] of Object.entries(saved)) {
        if (isPanelId(id) && typeof width === 'number') widths[id] = width;
      }
    } catch {
      // A value that no longer parses is skipped, and that panel starts at its default.
    }
  }
  return widths;
}

/**
 * localStorage, except that the first read with nothing under the new key gathers the old keys
 * instead. The old keys are left alone, so a downgrade still finds them.
 */
const storage: StateStorage = {
  getItem: (name) => {
    try {
      const saved = localStorage.getItem(name);
      if (saved !== null) return saved;
      const widths = legacyWidths();
      return Object.keys(widths).length > 0
        ? JSON.stringify({ state: { widths }, version: 0 })
        : null;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      // A window without storage still resizes, it just forgets the width.
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      // Nothing to forget.
    }
  },
};

interface PanelWidthState {
  widths: Partial<Record<PanelId, number>>;
  setWidth: (panel: PanelId, width: number) => void;
}

export const usePanelWidthStore = create<PanelWidthState>()(
  persist(
    (set) => ({
      widths: {},
      setWidth: (panel, width) => set((state) => ({ widths: { ...state.widths, [panel]: width } })),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => storage),
      partialize: (state) => ({ widths: state.widths }),
    },
  ),
);

/** A panel's saved width (or its default) and the setter a ResizeHandle reports to. */
export function usePanelWidth(panel: PanelId): [number, (width: number) => void] {
  const width = usePanelWidthStore((state) => state.widths[panel]) ?? PANEL_WIDTHS[panel].default;
  const setWidth = usePanelWidthStore((state) => state.setWidth);
  return [width, (next) => setWidth(panel, next)];
}
