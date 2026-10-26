import type { EnrollResponse } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { type CoreRest, coded } from './coreSessions';
import { createDeviceKey } from './deviceKey';

/**
 * Enrolling this computer with a single-use code an Owner made, instead of over SSH as root: a
 * fresh device key, whose public half goes to the core with the code and the user's password. The
 * private half stays here for the caller to seal. A refusal keeps its code (`[core:...]`), so the
 * dialog can tell a wrong code from a wrong password.
 */

export interface RedeemInput {
  code: string;
  userName: string;
  password: string;
  deviceName: string;
}

export interface RedeemedDevice {
  deviceId: string;
  /** PKCS#8 PEM. Seal it before storing it. */
  privateKeyPem: string;
}

export async function redeemEnrollmentCode(
  core: CoreRest,
  input: RedeemInput,
): Promise<RedeemedDevice> {
  const key = createDeviceKey();
  const enrolled = await coded(
    core.post<EnrollResponse>('/api/v1/auth/enroll', {
      code: input.code.trim(),
      userName: input.userName,
      password: input.password,
      publicKey: key.publicKey,
      deviceName: input.deviceName.trim(),
    }),
  );
  return { deviceId: enrolled.deviceId, privateKeyPem: key.privateKeyPem };
}
