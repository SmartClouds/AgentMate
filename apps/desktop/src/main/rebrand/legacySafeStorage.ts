import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import { LEGACY_APP_NAME } from '../../shared/legacyNames';

/**
 * On macOS and Linux the key behind safeStorage lives in the OS keyring under the app's name
 * ("AgentMate Safe Storage" before the rename), so secrets saved before it can't be read under
 * the new name. Electron picks that name up from app.setName while the main script loads, so the
 * only way to reach the old key is a second copy of the app that calls itself AgentMate. This
 * file is both halves: the helper that copy runs, and the call that starts it.
 */
const FLAG = '--runova-legacy-decrypt=';

/** The job file when this process was started as the helper, null for a normal start. */
export const legacyDecryptJob: string | null =
  process.argv.find((arg) => arg.startsWith(FLAG))?.slice(FLAG.length) ?? null;

interface Job {
  ciphertexts: string[];
}

/**
 * Turns this process into the helper. Must run while the main script loads, before the app is
 * ready. It reads the ciphertexts from the job file, writes the plaintexts to stdout as JSON and
 * exits. Nothing it decrypts touches the disk.
 */
export function runLegacyDecryptHelper(jobFile: string): void {
  app.setName(LEGACY_APP_NAME);
  const profile = join(tmpdir(), `runova-legacy-decrypt-${process.pid}`);
  app.setPath('userData', profile);
  if (process.platform === 'darwin') app.dock?.hide();
  void app.whenReady().then(() => {
    let code = 0;
    try {
      const job = JSON.parse(readFileSync(jobFile, 'utf8')) as Job;
      const plaintexts = job.ciphertexts.map((ciphertext) => {
        try {
          return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
        } catch {
          return null;
        }
      });
      writeSync(1, JSON.stringify({ plaintexts }));
    } catch {
      code = 1;
    }
    rmSync(profile, { recursive: true, force: true });
    app.exit(code);
  });
}

/**
 * Decrypts with the key from before the rename. Each entry is the plaintext, or null when the
 * old key can't open it either. The keyring may ask the user to allow access first, hence the
 * long timeout.
 */
export async function decryptWithLegacyKey(ciphertexts: string[]): Promise<(string | null)[]> {
  if (ciphertexts.length === 0) return [];
  const dir = await mkdtemp(join(tmpdir(), 'runova-legacy-'));
  const jobFile = join(dir, 'job.json');
  try {
    await writeFile(jobFile, JSON.stringify({ ciphertexts } satisfies Job), { mode: 0o600 });
    const args = [...(app.isPackaged ? [] : [app.getAppPath()]), `${FLAG}${jobFile}`];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        args,
        { env, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 },
        (error, out) => (error ? reject(error) : resolve(out)),
      );
    });
    const { plaintexts } = JSON.parse(stdout) as { plaintexts: (string | null)[] };
    if (!Array.isArray(plaintexts) || plaintexts.length !== ciphertexts.length) {
      throw new Error('The helper answered with the wrong number of secrets.');
    }
    return plaintexts;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
