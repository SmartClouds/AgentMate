import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StudioSecretsHost } from '@agentmat/studio/node';

/**
 * Studio's own keys (ElevenLabs, Azure Speech), sealed with the app's vault and kept in
 * `<userData>/data/studio/secrets.json`. The vault comes in through `seal`, `unseal` and
 * `isLocked`, since only host.ts may import the app's modules.
 */

/** `Envelope` is a sealed value as the vault writes it; Studio only stores it. */
interface SecretsFile<Envelope> {
  version: 1;
  secrets: Record<string, Envelope>;
}

export interface StudioSecretsDeps<Envelope> {
  file: string;
  seal(plaintext: string): Promise<Envelope>;
  unseal(envelope: Envelope): Promise<string>;
  isLocked(envelope: Envelope): boolean;
}

export interface StudioSecrets<Envelope> extends StudioSecretsHost {
  /** Re-seals every secret on a passkey change; see `registerSealedSecretStore`. */
  prepare(move: (envelope: Envelope) => Promise<Envelope>): Promise<() => Promise<void>>;
}

export function createStudioSecrets<Envelope>(
  deps: StudioSecretsDeps<Envelope>,
): StudioSecrets<Envelope> {
  type Stored = SecretsFile<Envelope>;
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<Stored> {
    try {
      const parsed = JSON.parse(await readFile(deps.file, 'utf8')) as Partial<Stored>;
      return { version: 1, secrets: parsed.secrets ?? {} };
    } catch {
      return { version: 1, secrets: {} };
    }
  }

  async function write(file: Stored): Promise<void> {
    await mkdir(dirname(deps.file), { recursive: true });
    const temp = `${deps.file}.tmp-${process.pid}`;
    await writeFile(temp, JSON.stringify(file, null, 2));
    await rename(temp, deps.file);
  }

  /** Changes run one at a time, so two saves never lose each other's key. */
  function update(change: (file: Stored) => Promise<Stored>): Promise<void> {
    const next = queue.then(async () => write(await change(await read())));
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    async get(name) {
      const envelope = (await read()).secrets[name];
      return envelope ? deps.unseal(envelope) : null;
    },

    set(name, value) {
      return update(async (file) => {
        const secrets = { ...file.secrets };
        if (value === null) delete secrets[name];
        else secrets[name] = await deps.seal(value);
        return { ...file, secrets };
      });
    },

    async isLocked(name) {
      const envelope = (await read()).secrets[name];
      return envelope ? deps.isLocked(envelope) : false;
    },

    async prepare(move) {
      const before = (await read()).secrets;
      const moved = Object.fromEntries(
        await Promise.all(
          Object.entries(before).map(async ([name, envelope]) => [name, await move(envelope)]),
        ),
      ) as Record<string, Envelope>;
      return () => update(async (file) => ({ ...file, secrets: { ...file.secrets, ...moved } }));
    },
  };
}
