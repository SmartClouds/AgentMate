import { randomBytes, timingSafeEqual } from 'node:crypto';
import { safeStorage } from 'electron';
import type {
  PassphraseSecretEnvelope,
  SecretEnvelope,
  SshVaultStatus,
  StoredProjectEnvironment,
  StoredRdpServer,
  StoredSshServer,
} from '../../shared/apiTypes';
import { decryptWithKey, deriveKey, encryptWithKey } from '../crypto/aesGcm';
import { store } from '../store';
import { VaultLockedError } from './vaultErrors';

/** Encrypted under a just-derived key and stashed alongside the salt, so a wrong passkey is
 *  rejected right away instead of producing garbage the first time a server tries to connect.
 *  Saved verifiers hold this exact text, so it keeps the name from before the Runova rename. */
const VERIFIER_PLAINTEXT = 'agentmate-ssh-vault'; // legacy-name

/** Cached for the running app session only; cleared on `before-quit`. Never persisted. */
let unlockedKey: Buffer | null = null;

const unlockListeners = new Set<() => void>();

/**
 * Runs `listener` each time the passkey opens the vault, so whatever was waiting on a locked
 * secret (the Deploy section's connections) can carry on. Returns a function that stops it.
 */
export function onVaultUnlocked(listener: () => void): () => void {
  unlockListeners.add(listener);
  return () => unlockListeners.delete(listener);
}

function verifyKey(key: Buffer, verifier: string): boolean {
  try {
    const envelope = JSON.parse(
      Buffer.from(verifier, 'base64').toString('utf-8'),
    ) as PassphraseSecretEnvelope;
    const plain = decryptWithKey(envelope, key);
    const actual = Buffer.from(plain, 'utf-8');
    const expected = Buffer.from(VERIFIER_PLAINTEXT, 'utf-8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    // Wrong key: GCM auth-tag check fails before the string comparison is reached.
    return false;
  }
}

function makeVerifier(key: Buffer): string {
  const envelope = encryptWithKey(VERIFIER_PLAINTEXT, key);
  return Buffer.from(JSON.stringify(envelope), 'utf-8').toString('base64');
}

export async function getVaultStatus(): Promise<SshVaultStatus> {
  const vault = await store.getSshVault();
  return { hasPasskey: vault != null, unlocked: unlockedKey != null };
}

export async function unlockVault(passphrase: string): Promise<boolean> {
  const vault = await store.getSshVault();
  if (!vault) {
    unlockedKey = null;
    return true;
  }
  const key = await deriveKey(passphrase, vault.salt);
  if (!verifyKey(key, vault.verifier)) return false;
  unlockedKey = key;
  for (const listener of [...unlockListeners]) listener();
  return true;
}

export function lockVault(): void {
  unlockedKey = null;
}

/**
 * A store outside this file that seals secrets with the vault (the Deploy section's device keys).
 * On a passkey change `prepare` re-encrypts its secrets with `move` without saving anything, and
 * the function it returns saves them once every list has moved, so a failure part way leaves all
 * of them as they were.
 */
export interface SealedSecretStore {
  prepare: (
    move: (envelope: SecretEnvelope) => Promise<SecretEnvelope>,
  ) => Promise<() => Promise<void>>;
}

const sealedStores = new Set<SealedSecretStore>();

/** Returns a function that unregisters the store again. */
export function registerSealedSecretStore(sealed: SealedSecretStore): () => void {
  sealedStores.add(sealed);
  return () => {
    sealedStores.delete(sealed);
  };
}

/**
 * Turns the optional Servers passkey on, off, or to a new value. Re-encrypts every saved
 * server's secret between safeStorage and passphrase-derived modes so nothing is left stuck
 * under a key nothing can reach anymore. Changing away from an existing passkey requires the
 * vault to already be unlocked, since decrypting the current secrets needs that key.
 */
export async function setPasskey(
  passphrase: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const currentVault = await store.getSshVault();
  if (currentVault && !unlockedKey) {
    return { ok: false, error: 'Unlock the current passkey first.' };
  }

  const salt = randomBytes(16).toString('base64');
  const nextKey = passphrase ? await deriveKey(passphrase, salt) : null;

  const move = async (envelope: SecretEnvelope): Promise<SecretEnvelope> => {
    const plaintext = await decryptSecret(envelope);
    return nextKey ? encryptWithKey(plaintext, nextKey) : encryptWithSafeStorage(plaintext);
  };

  let commit: () => Promise<void>;
  try {
    commit = await prepareRewrite(move);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  await commit();
  await store.setSshVault(nextKey ? { salt, verifier: makeVerifier(nextKey) } : null);
  unlockedKey = nextKey;
  return { ok: true };
}

/**
 * Runs `move` over every saved secret: SSH servers, Remote Desktop servers and project
 * environments share the one passkey, and so do the sealed stores, so every list moves together.
 * Nothing is saved until the returned function runs, so a failure part way leaves all of them as
 * they were.
 */
async function prepareRewrite(
  moveSecret: (envelope: SecretEnvelope) => Promise<SecretEnvelope>,
): Promise<() => Promise<void>> {
  async function move(envelope: SecretEnvelope): Promise<SecretEnvelope>;
  async function move(envelope: SecretEnvelope | undefined): Promise<SecretEnvelope | undefined>;
  async function move(envelope: SecretEnvelope | undefined): Promise<SecretEnvelope | undefined> {
    return envelope ? moveSecret(envelope) : undefined;
  }
  async function reencrypt<T extends { secretEnvelope?: SecretEnvelope }>(
    servers: T[],
  ): Promise<T[]> {
    return Promise.all(
      servers.map(async (server) =>
        server.secretEnvelope
          ? { ...server, secretEnvelope: await moveSecret(server.secretEnvelope) }
          : server,
      ),
    );
  }

  const sshServers: StoredSshServer[] = await reencrypt(await store.getSshServers());
  const rdpServers: StoredRdpServer[] = await reencrypt(await store.getRdpServers());
  const environments: StoredProjectEnvironment[] = await Promise.all(
    (await store.getProjectEnvironments()).map(async (environment) => ({
      ...environment,
      files: await Promise.all(
        environment.files.map(async (file) => ({
          ...file,
          contentEnvelope: await move(file.contentEnvelope),
        })),
      ),
      credentials: await Promise.all(
        environment.credentials.map(async (credential) => ({
          ...credential,
          secretEnvelope: await move(credential.secretEnvelope),
          notesEnvelope: await move(credential.notesEnvelope),
        })),
      ),
    })),
  );
  const commitSealed = await Promise.all(
    [...sealedStores].map((sealed) => sealed.prepare(moveSecret)),
  );
  return async () => {
    await store.setSshServers(sshServers);
    await store.setRdpServers(rdpServers);
    await store.setProjectEnvironments(environments);
    for (const commitOne of commitSealed) await commitOne();
  };
}

/**
 * On macOS and Linux the safeStorage key is kept in the OS keyring under the app's name, so the
 * secrets saved before the rename from the old name are sealed under a key the renamed app can't
 * reach. This opens those with `decryptLegacy` (a helper that runs under the old name) and seals
 * them again under the current key. Secrets that open already, and passkey ones, are left as they
 * are. Returns how many moved and how many neither key could open.
 */
export async function migrateLegacySafeStorage(
  decryptLegacy: (ciphertexts: string[]) => Promise<(string | null)[]>,
): Promise<{ moved: number; unreadable: number }> {
  if (!safeStorage.isEncryptionAvailable()) return { moved: 0, unreadable: 0 };
  const opensNow = (envelope: SecretEnvelope): boolean => {
    try {
      safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
      return true;
    } catch {
      return false;
    }
  };

  // First pass only looks: which safeStorage secrets does the current key fail on?
  const stale = new Set<string>();
  await prepareRewrite(async (envelope) => {
    if (envelope.mode === 'safeStorage' && !opensNow(envelope)) stale.add(envelope.ciphertext);
    return envelope;
  });
  if (stale.size === 0) return { moved: 0, unreadable: 0 };

  const ciphertexts = [...stale];
  const plaintexts = await decryptWithLegacy(ciphertexts, decryptLegacy);
  let moved = 0;
  const commit = await prepareRewrite(async (envelope) => {
    if (envelope.mode !== 'safeStorage') return envelope;
    const plaintext = plaintexts.get(envelope.ciphertext);
    if (plaintext == null) return envelope;
    moved += 1;
    return encryptWithSafeStorage(plaintext);
  });
  await commit();
  return { moved, unreadable: ciphertexts.length - plaintexts.size };
}

async function decryptWithLegacy(
  ciphertexts: string[],
  decryptLegacy: (ciphertexts: string[]) => Promise<(string | null)[]>,
): Promise<Map<string, string>> {
  const opened = await decryptLegacy(ciphertexts);
  const plaintexts = new Map<string, string>();
  ciphertexts.forEach((ciphertext, index) => {
    const plaintext = opened[index];
    if (plaintext != null) plaintexts.set(ciphertext, plaintext);
  });
  return plaintexts;
}

function encryptWithSafeStorage(plaintext: string): SecretEnvelope {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Secure storage is not available on this system. Set a Servers passkey to encrypt credentials.',
    );
  }
  return {
    mode: 'safeStorage',
    ciphertext: safeStorage.encryptString(plaintext).toString('base64'),
  };
}

/** Encrypts under the unlocked passkey if one is set, otherwise under safeStorage. */
export async function encryptSecret(plaintext: string): Promise<SecretEnvelope> {
  if (unlockedKey) return encryptWithKey(plaintext, unlockedKey);
  const vault = await store.getSshVault();
  if (vault) throw new VaultLockedError();
  return encryptWithSafeStorage(plaintext);
}

/** Whether reading this secret needs the passkey, which is locked right now. */
export function isLockedEnvelope(envelope: SecretEnvelope | undefined): boolean {
  return envelope?.mode === 'passphrase' && unlockedKey == null;
}

export async function decryptSecret(envelope: SecretEnvelope): Promise<string> {
  if (envelope.mode === 'safeStorage') {
    return safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
  }
  if (!unlockedKey) throw new VaultLockedError();
  return decryptWithKey(envelope, unlockedKey);
}
