import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Computers this phone has paired with. Pairing once (via QR / code) yields a
 * durable device token from the host, so the connection details are saved here
 * and the user can reconnect with one tap, no new code needed. The list
 * survives app restarts (AsyncStorage) just like the token survives host
 * restarts (persisted on the desktop side).
 */
export interface SavedDevice {
  id: string;
  /** User-editable display name; defaults to the host's computer name. */
  label: string;
  /** The host's reported computer name (used to de-duplicate entries). */
  hostName: string;
  ip: string;
  port: number;
  /** Durable token issued by the host on first pairing. */
  token: string;
  addedAt: number;
  lastConnectedAt: number;
}

const STORAGE_KEY = 'runova.savedDevices.v1';

export async function loadSavedDevices(): Promise<SavedDevice[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is SavedDevice =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as SavedDevice).id === 'string' &&
        typeof (d as SavedDevice).token === 'string' &&
        typeof (d as SavedDevice).ip === 'string' &&
        typeof (d as SavedDevice).port === 'number',
    );
  } catch {
    return [];
  }
}

async function persist(devices: SavedDevice[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
}

/**
 * Insert or refresh a device after a successful pairing. Matches on the host's
 * computer name so re-pairing the same machine (new token, maybe a new DHCP
 * address) updates the entry instead of duplicating it.
 */
export async function upsertSavedDevice(input: {
  hostName: string;
  ip: string;
  port: number;
  token: string;
}): Promise<SavedDevice[]> {
  const devices = await loadSavedDevices();
  const now = Date.now();
  const existing = devices.find((d) => d.hostName === input.hostName);
  if (existing) {
    existing.ip = input.ip;
    existing.port = input.port;
    existing.token = input.token;
    existing.lastConnectedAt = now;
  } else {
    devices.push({
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      label: input.hostName,
      hostName: input.hostName,
      ip: input.ip,
      port: input.port,
      token: input.token,
      addedAt: now,
      lastConnectedAt: now,
    });
  }
  devices.sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
  await persist(devices);
  return devices;
}

export async function touchSavedDevice(id: string): Promise<SavedDevice[]> {
  const devices = await loadSavedDevices();
  const device = devices.find((d) => d.id === id);
  if (device) device.lastConnectedAt = Date.now();
  devices.sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
  await persist(devices);
  return devices;
}

export async function renameSavedDevice(id: string, label: string): Promise<SavedDevice[]> {
  const devices = await loadSavedDevices();
  const device = devices.find((d) => d.id === id);
  if (device && label.trim()) device.label = label.trim();
  await persist(devices);
  return devices;
}

export async function removeSavedDevice(id: string): Promise<SavedDevice[]> {
  const devices = (await loadSavedDevices()).filter((d) => d.id !== id);
  await persist(devices);
  return devices;
}
