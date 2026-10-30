import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { SecretEnvelope } from '../../shared/apiTypes';
import type { SealedSecretStore } from '../ssh/vault';

/**
 * The Google accounts at rest, in google-cloud.json beside the other stores (E40). Each account's
 * refresh token, and the client secret when the user brought their own OAuth client, is only ever
 * stored sealed with the Servers vault (safeStorage, or the passkey when one is set) and never
 * leaves the main process. Anything unreadable is dropped rather than trusted, and one write queue
 * keeps two changes from losing each other.
 */

export interface StoredGoogleAccount {
  id: string;
  email: string;
  clientMode: 'runova' | 'own';
  clientId: string;
  /** Only for the user's own client; Runova's ships with the app. */
  clientSecret: SecretEnvelope | null;
  refreshToken: SecretEnvelope;
  projectId: string | null;
  /** Google refused the refresh token, so the user has to sign in again. */
  needsSignIn: boolean;
  addedAt: string;
}

export interface GoogleCloudStateFile {
  version: 1;
  accounts: StoredGoogleAccount[];
}

export interface GoogleCloudStatePort {
  /** The parsed file, or null when there is none or it is not JSON. */
  read: () => Promise<unknown>;
  write: (value: GoogleCloudStateFile) => Promise<void>;
}

const envelopeSchema = z.union([
  z.object({ mode: z.literal('safeStorage'), ciphertext: z.string() }),
  z.object({
    mode: z.literal('passphrase'),
    iv: z.string(),
    authTag: z.string(),
    ciphertext: z.string(),
  }),
]);

const accountSchema = z.object({
  id: z.string().min(1).max(128),
  email: z.string().max(320),
  clientMode: z.enum(['runova', 'own']),
  clientId: z.string().min(1).max(1024),
  clientSecret: envelopeSchema.nullable(),
  refreshToken: envelopeSchema,
  projectId: z.string().max(100).nullable(),
  needsSignIn: z.boolean(),
  addedAt: z.string().max(64),
});

function parse(value: unknown): GoogleCloudStateFile {
  const file: GoogleCloudStateFile = { version: 1, accounts: [] };
  if (typeof value !== 'object' || value === null) return file;
  const { version, accounts } = value as { version?: unknown; accounts?: unknown };
  if (version !== 1 || !Array.isArray(accounts)) return file;
  for (const raw of accounts) {
    const parsed = accountSchema.safeParse(raw);
    if (parsed.success && !file.accounts.some((one) => one.id === parsed.data.id)) {
      file.accounts.push(parsed.data);
    }
  }
  return file;
}

export class GoogleCloudState {
  private queue: Promise<unknown> = Promise.resolve();

  /** Moves every sealed secret when the Servers passkey changes (see vault.ts). */
  readonly sealedKeys: SealedSecretStore = {
    prepare: async (move) => {
      const moved = new Map<string, Pick<StoredGoogleAccount, 'refreshToken' | 'clientSecret'>>();
      for (const account of (await this.read()).accounts) {
        moved.set(account.id, {
          refreshToken: await move(account.refreshToken),
          clientSecret: account.clientSecret ? await move(account.clientSecret) : null,
        });
      }
      return () =>
        this.update((file) => ({
          ...file,
          accounts: file.accounts.map((account) => {
            const sealed = moved.get(account.id);
            return sealed ? { ...account, ...sealed } : account;
          }),
        }));
    },
  };

  constructor(private readonly port: GoogleCloudStatePort) {}

  async accounts(): Promise<StoredGoogleAccount[]> {
    return (await this.read()).accounts;
  }

  async account(id: string): Promise<StoredGoogleAccount | null> {
    return (await this.read()).accounts.find((account) => account.id === id) ?? null;
  }

  /** Adds an account, or replaces the account with the same id. */
  save(account: StoredGoogleAccount): Promise<void> {
    return this.update((file) => ({
      ...file,
      accounts: file.accounts.some((item) => item.id === account.id)
        ? file.accounts.map((item) => (item.id === account.id ? account : item))
        : [...file.accounts, account],
    }));
  }

  setProject(id: string, projectId: string | null): Promise<void> {
    return this.change(id, (account) => ({ ...account, projectId }));
  }

  setNeedsSignIn(id: string, needsSignIn: boolean): Promise<void> {
    return this.change(id, (account) => ({ ...account, needsSignIn }));
  }

  remove(id: string): Promise<void> {
    return this.update((file) => ({
      ...file,
      accounts: file.accounts.filter((account) => account.id !== id),
    }));
  }

  private change(
    id: string,
    edit: (account: StoredGoogleAccount) => StoredGoogleAccount,
  ): Promise<void> {
    return this.update((file) => ({
      ...file,
      accounts: file.accounts.map((account) => (account.id === id ? edit(account) : account)),
    }));
  }

  private async read(): Promise<GoogleCloudStateFile> {
    await this.queue.catch(() => undefined);
    return parse(await this.port.read());
  }

  private update(change: (file: GoogleCloudStateFile) => GoogleCloudStateFile): Promise<void> {
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
export function googleCloudFilePort(path: string): GoogleCloudStatePort {
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
