import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadSavedDevices,
  removeSavedDevice,
  renameSavedDevice,
  type SavedDevice,
  touchSavedDevice,
  upsertSavedDevice,
} from './savedDevices';

const STORAGE_KEY = 'runova.savedDevices.v1';

function device(overrides: Partial<SavedDevice> = {}): SavedDevice {
  return {
    id: 'dev-1',
    label: 'Studio PC',
    hostName: 'STUDIO-PC',
    ip: '192.168.1.10',
    port: 47291,
    token: 'token-1',
    addedAt: 1000,
    lastConnectedAt: 1000,
    ...overrides,
  };
}

async function seed(value: unknown): Promise<void> {
  await AsyncStorage.setItem(
    STORAGE_KEY,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

async function stored(): Promise<SavedDevice[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as SavedDevice[]) : [];
}

describe('savedDevices', () => {
  beforeEach(async () => {
    // Each test owns the whole list, so a leftover entry from the previous one
    // would silently change the ordering and de-duplication assertions.
    await AsyncStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('loadSavedDevices', () => {
    it('returns an empty list on a fresh install', async () => {
      await expect(loadSavedDevices()).resolves.toEqual([]);
    });

    it('returns an empty list instead of throwing on corrupt JSON', async () => {
      // A half-written record must not brick the connect screen on launch.
      await seed('{not json');
      await expect(loadSavedDevices()).resolves.toEqual([]);
    });

    it('returns an empty list when the stored value is not an array', async () => {
      // An older/foreign shape (an object, say) would break every .filter/.find below.
      await seed({ devices: [device()] });
      await expect(loadSavedDevices()).resolves.toEqual([]);
    });

    it('drops entries missing or mistyping the fields needed to dial', async () => {
      await seed([
        device({ id: 'good' }),
        { ...device({ id: 'no-token' }), token: undefined },
        { ...device({ id: 'numeric-ip' }), ip: 19216811 },
        { ...device({ id: 'string-port' }), port: '47291' },
        { ...device({ id: 'no-id' }), id: undefined },
        null,
        'not-a-device',
      ]);
      const devices = await loadSavedDevices();
      expect(devices.map((d) => d.id)).toEqual(['good']);
    });
  });

  describe('upsertSavedDevice', () => {
    it('inserts a new device with the host name as its default label', async () => {
      const devices = await upsertSavedDevice({
        hostName: 'STUDIO-PC',
        ip: '192.168.1.10',
        port: 47291,
        token: 'fresh-token',
      });
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({
        label: 'STUDIO-PC',
        hostName: 'STUDIO-PC',
        ip: '192.168.1.10',
        port: 47291,
        token: 'fresh-token',
      });
      expect(devices[0].id).toBeTruthy();
      await expect(stored()).resolves.toHaveLength(1);
    });

    it('updates the matching host instead of duplicating it', async () => {
      // Re-pairing the same computer hands out a new token and often a new DHCP
      // address; the list must show one entry, not one per pairing.
      await seed([device({ label: 'My rename', ip: '192.168.1.10', token: 'old-token' })]);
      const devices = await upsertSavedDevice({
        hostName: 'STUDIO-PC',
        ip: '192.168.1.55',
        port: 51000,
        token: 'new-token',
      });
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({
        id: 'dev-1',
        // The user's own label survives a re-pair; only the dialing details change.
        label: 'My rename',
        ip: '192.168.1.55',
        port: 51000,
        token: 'new-token',
      });
    });

    it('keeps a different host as its own entry', async () => {
      await seed([device()]);
      const devices = await upsertSavedDevice({
        hostName: 'LAPTOP',
        ip: '192.168.1.11',
        port: 47291,
        token: 'token-2',
      });
      expect(devices.map((d) => d.hostName).sort()).toEqual(['LAPTOP', 'STUDIO-PC']);
    });

    it('puts the just-connected device first', async () => {
      // The connect screen renders this order straight through, so "most
      // recently used at the top" is decided here.
      await seed([
        device({ id: 'a', hostName: 'A', lastConnectedAt: 5000 }),
        device({ id: 'b', hostName: 'B', lastConnectedAt: 9000 }),
      ]);
      jest.spyOn(Date, 'now').mockReturnValue(20_000);
      const devices = await upsertSavedDevice({
        hostName: 'A',
        ip: '192.168.1.10',
        port: 47291,
        token: 'token-a',
      });
      expect(devices.map((d) => d.id)).toEqual(['a', 'b']);
      expect(devices[0].lastConnectedAt).toBe(20_000);
    });
  });

  describe('touchSavedDevice', () => {
    it('refreshes lastConnectedAt and re-sorts the list', async () => {
      await seed([
        device({ id: 'a', hostName: 'A', lastConnectedAt: 5000 }),
        device({ id: 'b', hostName: 'B', lastConnectedAt: 9000 }),
      ]);
      jest.spyOn(Date, 'now').mockReturnValue(30_000);
      const devices = await touchSavedDevice('a');
      expect(devices.map((d) => d.id)).toEqual(['a', 'b']);
      expect(devices[0].lastConnectedAt).toBe(30_000);
    });

    it('leaves the list alone for an unknown id', async () => {
      await seed([device({ lastConnectedAt: 5000 })]);
      const devices = await touchSavedDevice('nope');
      expect(devices[0].lastConnectedAt).toBe(5000);
    });
  });

  describe('renameSavedDevice', () => {
    it('trims the new label', async () => {
      await seed([device()]);
      const devices = await renameSavedDevice('dev-1', '  Living room  ');
      expect(devices[0].label).toBe('Living room');
      await expect(stored()).resolves.toMatchObject([{ label: 'Living room' }]);
    });

    it('ignores a blank label rather than leaving an unnamed row', async () => {
      await seed([device({ label: 'Studio PC' })]);
      const devices = await renameSavedDevice('dev-1', '   ');
      expect(devices[0].label).toBe('Studio PC');
    });

    it('is a no-op for an unknown id', async () => {
      await seed([device()]);
      const devices = await renameSavedDevice('nope', 'Anything');
      expect(devices[0].label).toBe('Studio PC');
    });
  });

  describe('removeSavedDevice', () => {
    it('forgets only the requested device and persists the result', async () => {
      await seed([device({ id: 'a', hostName: 'A' }), device({ id: 'b', hostName: 'B' })]);
      const devices = await removeSavedDevice('a');
      expect(devices.map((d) => d.id)).toEqual(['b']);
      await expect(stored()).resolves.toMatchObject([{ id: 'b' }]);
    });

    it('keeps everything when the id is not in the list', async () => {
      await seed([device()]);
      await expect(removeSavedDevice('nope')).resolves.toHaveLength(1);
    });
  });
});
