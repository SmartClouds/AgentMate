import { quoteForShell } from '@runova/core';
import { sshErrorMessage } from '../../../shared/sshErrors';
import type { RootShell } from '../../ssh/sudo';
import { createDeviceKey } from '../auth/deviceKey';
import { CORE_PROGRAM } from '../coreProgram';
import type { InstallProgress } from './installer';

/**
 * Enrolling this computer on a core, over SSH as root: on a new core the owner account is created
 * first, then a fresh device key's public half is registered for the user. The password and the
 * key only ever travel on stdin (the admin commands read them from there), never on a command
 * line, where `ps` and shell history on the server would show them. The private key never
 * leaves this computer.
 */

export interface EnrollmentInput {
  userName: string;
  /** The new owner's password on a new core; the user's own password otherwise (to sign in). */
  password: string;
  deviceName: string;
}

export interface Enrollment {
  deviceId: string;
  userName: string;
  /** PKCS#8 PEM. The caller seals it before storing it. */
  privateKeyPem: string;
  createdOwner: boolean;
}

/** Identity's allowed user name characters on the core. */
const USER_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 256;
const STEP_TIMEOUT_MS = 60_000;

const q = (value: string): string => quoteForShell(value, 'posix');

/** The same rules the core applies, checked before anything reaches the server. */
export function checkEnrollmentInput(input: EnrollmentInput): string | null {
  if (!USER_NAME.test(input.userName)) {
    return 'A user name has 1 to 64 letters, digits, dots, dashes, underscores or @.';
  }
  if (/[\r\n]/.test(input.password)) return 'A password cannot contain a line break.';
  if (input.password.length < MIN_PASSWORD)
    return `A password needs at least ${MIN_PASSWORD} characters.`;
  if (input.password.length > MAX_PASSWORD)
    return `A password can be at most ${MAX_PASSWORD} characters.`;
  if (
    /[\r\n]/.test(input.deviceName) ||
    input.deviceName.trim().length === 0 ||
    input.deviceName.length > 100
  ) {
    return 'A device name has 1 to 100 characters on one line.';
  }
  return null;
}

interface CoreStatus {
  initialized: boolean;
  users: Array<{ userName: string }>;
}

export async function enrollOverSsh(
  shell: Pick<RootShell, 'run'>,
  input: EnrollmentInput,
  onProgress?: (event: InstallProgress) => void,
): Promise<Enrollment> {
  const problem = checkEnrollmentInput(input);
  if (problem) throw new Error(problem);

  const emit = (event: InstallProgress) => onProgress?.(event);
  const step = async <T>(
    phase: 'owner' | 'enroll',
    title: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    emit({ phase, title, status: 'running' });
    try {
      const result = await work();
      emit({ phase, title, status: 'done' });
      return result;
    } catch (error) {
      emit({ phase, title, status: 'failed', detail: sshErrorMessage(error) });
      throw error;
    }
  };
  const admin = async (args: string, stdin?: string) => {
    const result = await shell.run(`${CORE_PROGRAM} admin ${args}`, {
      timeoutMs: STEP_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      ...(stdin === undefined ? {} : { stdin }),
    });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(
        result.stderr.trim() || `The core's admin command failed (exit ${result.exitCode}).`,
      );
    }
    return JSON.parse(result.stdout) as unknown;
  };

  const status = (await admin('status')) as CoreStatus;
  let createdOwner = false;
  await step('owner', 'Set up your account on the core', async () => {
    if (!status.initialized) {
      await admin(
        `create-owner --username ${q(input.userName)} --password-stdin`,
        `${input.password}\n`,
      );
      createdOwner = true;
    } else if (
      !status.users.some((user) => user.userName.toLowerCase() === input.userName.toLowerCase())
    ) {
      throw new Error(`This core has no user called ${input.userName}.`);
    }
  });

  const key = createDeviceKey();
  const enrolled = await step(
    'enroll',
    'Enroll this computer',
    async () =>
      (await admin(
        `enroll-device --user ${q(input.userName)} --name ${q(input.deviceName.trim())}`,
        `${key.publicKey}\n`,
      )) as { deviceId: string },
  );

  return {
    deviceId: enrolled.deviceId,
    userName: input.userName,
    privateKeyPem: key.privateKeyPem,
    createdOwner,
  };
}
