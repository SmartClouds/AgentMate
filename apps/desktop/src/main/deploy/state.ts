import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SecretEnvelope } from '../../shared/apiTypes';
import type { AlertSeverity } from '../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { DeployDirectTlsPin } from '../../shared/deployDirectTlsTypes';
import type { DeployCoreRecord, DeployTransport } from '../../shared/deployTypes';
import type { SealedSecretStore } from '../ssh/vault';

/**
 * The app's record of the core it installed on each saved server, and of this computer's device
 * on it, in `deploy.json` beside the other stores. Core records only cache what the server can
 * confirm again, so anything unreadable is dropped rather than trusted. Device credentials never
 * go to the renderer; their private key is only ever stored sealed with the Servers vault. One
 * write queue keeps two installs from losing each other's record.
 */

/** This computer's enrolled device on one server core. Main process only. */
export interface DeviceCredentials {
  deviceId: string;
  userName: string;
  /** The device's PKCS#8 private key, sealed with the Servers vault. */
  privateKey: SecretEnvelope;
  /** The current device session, renewed with a signature; not a secret on its own. */
  sessionId?: string;
  /**
   * The account password, sealed with the Servers vault, only when the user asked this computer
   * to remember it. It answers the core's step-up for them; sign-in never uses it.
   */
  password?: SecretEnvelope;
}

/**
 * How far the alert watcher got on one server: the highest revision it handled, and the severity
 * of each alert it saw open (by id), so nothing is announced twice, a restart included.
 */
export interface AlertMark {
  revision: number;
  open: Record<string, AlertSeverity>;
}

export interface DeployStateFile {
  version: 1;
  cores: Record<string, DeployCoreRecord>;
  devices: Record<string, DeviceCredentials>;
  /** Left out by files written before E05. */
  alerts?: Record<string, AlertMark>;
  /** Direct TLS pins, read over SSH (E16); left out by older files. */
  directTls?: Record<string, DeployDirectTlsPin>;
}

export interface DeployStatePort {
  /** The parsed file, or null when there is none or it is not JSON. */
  read: () => Promise<unknown>;
  write: (value: DeployStateFile) => Promise<void>;
}

const TRANSPORTS: ReadonlySet<string> = new Set<DeployTransport>([
  'streamlocal',
  'bridge',
  'dev-tcp',
]);

function isRecord(value: unknown): value is DeployCoreRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.version === 'string' &&
    typeof record.release === 'string' &&
    typeof record.transport === 'string' &&
    TRANSPORTS.has(record.transport) &&
    typeof record.installedAt === 'number' &&
    typeof record.os === 'string' &&
    typeof record.architecture === 'string'
  );
}

function isEnvelope(value: unknown): value is SecretEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.ciphertext !== 'string') return false;
  if (envelope.mode === 'safeStorage') return true;
  return (
    envelope.mode === 'passphrase' &&
    typeof envelope.iv === 'string' &&
    typeof envelope.authTag === 'string'
  );
}

function isDevice(value: unknown): value is DeviceCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const device = value as Record<string, unknown>;
  return (
    typeof device.deviceId === 'string' &&
    typeof device.userName === 'string' &&
    isEnvelope(device.privateKey) &&
    (device.sessionId === undefined || typeof device.sessionId === 'string') &&
    (device.password === undefined || isEnvelope(device.password))
  );
}

function isPin(value: unknown): value is DeployDirectTlsPin {
  if (typeof value !== 'object' || value === null) return false;
  const pin = value as Record<string, unknown>;
  return (
    typeof pin.enabled === 'boolean' &&
    typeof pin.port === 'number' &&
    Number.isSafeInteger(pin.port) &&
    pin.port > 0 &&
    pin.port <= 65535 &&
    typeof pin.pin === 'string' &&
    /^[A-Za-z0-9+/]{43}=$/.test(pin.pin) &&
    typeof pin.pinnedAt === 'number'
  );
}

const SEVERITIES: ReadonlySet<string> = new Set<AlertSeverity>(['info', 'warning', 'critical']);

function parseMark(value: unknown): AlertMark | null {
  if (typeof value !== 'object' || value === null) return null;
  const mark = value as { revision?: unknown; open?: unknown };
  if (typeof mark.revision !== 'number' || !Number.isSafeInteger(mark.revision)) return null;
  if (mark.revision < 0) return null;
  const open: Record<string, AlertSeverity> = {};
  if (typeof mark.open === 'object' && mark.open !== null) {
    for (const [id, severity] of Object.entries(mark.open)) {
      if (typeof severity === 'string' && SEVERITIES.has(severity)) {
        open[id] = severity as AlertSeverity;
      }
    }
  }
  return { revision: mark.revision, open };
}

function parse(value: unknown): DeployStateFile {
  const file = (value ?? {}) as {
    version?: unknown;
    cores?: unknown;
    devices?: unknown;
    alerts?: unknown;
    directTls?: unknown;
  };
  const cores: Record<string, DeployCoreRecord> = {};
  const devices: Record<string, DeviceCredentials> = {};
  const alerts: Record<string, AlertMark> = {};
  const directTls: Record<string, DeployDirectTlsPin> = {};
  if (file.version === 1) {
    if (typeof file.cores === 'object' && file.cores !== null) {
      for (const [serverId, record] of Object.entries(file.cores)) {
        if (isRecord(record)) cores[serverId] = record;
      }
    }
    if (typeof file.devices === 'object' && file.devices !== null) {
      for (const [serverId, device] of Object.entries(file.devices)) {
        if (isDevice(device)) devices[serverId] = device;
      }
    }
    if (typeof file.alerts === 'object' && file.alerts !== null) {
      for (const [serverId, value] of Object.entries(file.alerts)) {
        const mark = parseMark(value);
        if (mark) alerts[serverId] = mark;
      }
    }
    if (typeof file.directTls === 'object' && file.directTls !== null) {
      for (const [serverId, pin] of Object.entries(file.directTls)) {
        if (isPin(pin)) directTls[serverId] = pin;
      }
    }
  }
  return { version: 1, cores, devices, alerts, directTls };
}

export class DeployState {
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Moves every sealed device key, and every remembered password, when the Servers passkey
   * changes (see vault.ts).
   */
  readonly sealedKeys: SealedSecretStore = {
    prepare: async (move) => {
      const devices = (await this.read()).devices;
      const moved: Record<string, Pick<DeviceCredentials, 'privateKey' | 'password'>> = {};
      for (const [serverId, device] of Object.entries(devices)) {
        moved[serverId] = {
          privateKey: await move(device.privateKey),
          ...(device.password ? { password: await move(device.password) } : {}),
        };
      }
      return () =>
        this.update((file) => {
          const next = { ...file.devices };
          for (const [serverId, sealed] of Object.entries(moved)) {
            const device = next[serverId];
            if (device) next[serverId] = { ...device, ...sealed };
          }
          return { ...file, devices: next };
        });
    },
  };

  constructor(private readonly port: DeployStatePort) {}

  async all(): Promise<Record<string, DeployCoreRecord>> {
    return (await this.read()).cores;
  }

  async get(serverId: string): Promise<DeployCoreRecord | null> {
    return (await this.all())[serverId] ?? null;
  }

  set(serverId: string, record: DeployCoreRecord): Promise<void> {
    return this.update((file) => ({ ...file, cores: { ...file.cores, [serverId]: record } }));
  }

  /** Forgets the core, and this computer's device on it (and what it saw of its alerts) with it. */
  remove(serverId: string): Promise<void> {
    return this.update((file) => {
      const { [serverId]: _core, ...cores } = file.cores;
      const { [serverId]: _device, ...devices } = file.devices;
      const { [serverId]: _mark, ...alerts } = file.alerts ?? {};
      const { [serverId]: _pin, ...directTls } = file.directTls ?? {};
      return { ...file, cores, devices, alerts, directTls };
    });
  }

  async alertMark(serverId: string): Promise<AlertMark | null> {
    return (await this.read()).alerts?.[serverId] ?? null;
  }

  setAlertMark(serverId: string, mark: AlertMark): Promise<void> {
    return this.update((file) => ({ ...file, alerts: { ...file.alerts, [serverId]: mark } }));
  }

  /** The direct TLS pin this computer took over SSH, if any. */
  async directTls(serverId: string): Promise<DeployDirectTlsPin | null> {
    return (await this.read()).directTls?.[serverId] ?? null;
  }

  /** Only ever with a pin read over SSH (see directTls/service.ts). */
  setDirectTls(serverId: string, pin: DeployDirectTlsPin): Promise<void> {
    return this.update((file) => ({ ...file, directTls: { ...file.directTls, [serverId]: pin } }));
  }

  /** Servers this computer has a device on. */
  async enrolledServers(): Promise<Set<string>> {
    return new Set(Object.keys((await this.read()).devices));
  }

  async device(serverId: string): Promise<DeviceCredentials | null> {
    return (await this.read()).devices[serverId] ?? null;
  }

  setDevice(serverId: string, device: DeviceCredentials): Promise<void> {
    return this.update((file) => ({ ...file, devices: { ...file.devices, [serverId]: device } }));
  }

  /** Remembers the device's sealed password, or forgets it with null. With no device, nothing changes. */
  setPassword(serverId: string, password: SecretEnvelope | null): Promise<void> {
    return this.update((file) => {
      const device = file.devices[serverId];
      if (!device) return file;
      const { password: _old, ...rest } = device;
      return {
        ...file,
        devices: { ...file.devices, [serverId]: password ? { ...rest, password } : rest },
      };
    });
  }

  removeDevice(serverId: string): Promise<void> {
    return this.update((file) => {
      const { [serverId]: _device, ...devices } = file.devices;
      return { ...file, devices };
    });
  }

  private async read(): Promise<DeployStateFile> {
    await this.queue.catch(() => undefined);
    return parse(await this.port.read());
  }

  private update(change: (file: DeployStateFile) => DeployStateFile): Promise<void> {
    const next = this.queue
      .catch(() => undefined)
      .then(async () => {
        await this.port.write(change(parse(await this.port.read())));
      });
    this.queue = next;
    return next;
  }
}

/** A JSON file written to a temporary name and renamed over, readable only by the user. */
export function jsonFilePort(path: string): DeployStatePort {
  return {
    async read() {
      let raw: string;
      try {
        raw = await readFile(path, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
    async write(value) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      await rename(temporary, path);
    },
  };
}
