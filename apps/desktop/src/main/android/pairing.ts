import {
  type AndroidActionResult,
  normalizeHostPort,
  parseAdbConnectResult,
  parseAdbPairResult,
  parseDeviceIpFromIpRoute,
} from '@runova/core';
import { runAdb } from './exec';
import type { ResolvedAndroidSdk } from './sdk';

/**
 * Wireless debugging.
 *
 * The host, port and code all come from what the user read off their phone screen and typed in,
 * and all three land on an adb command line. They are validated here rather than escaped: a value
 * that is not a plain host and port, or not six digits, is simply refused.
 */

/** The phone shows a six-digit code and nothing else. */
const PAIRING_CODE = /^\d{6}$/;

/** The port adb listens on for a normal connection, as opposed to the one-time pairing port. */
export const ADB_CONNECT_PORT = 5555;

export async function pairDevice(
  sdk: ResolvedAndroidSdk,
  hostPort: string,
  code: string,
): Promise<AndroidActionResult> {
  const target = normalizeHostPort(hostPort);
  if (!target) {
    return { ok: false, message: 'Enter the address and port exactly as the phone shows them.' };
  }
  if (!PAIRING_CODE.test(code.trim())) {
    return { ok: false, message: 'The pairing code is six digits.' };
  }

  try {
    const stdout = await runAdb(sdk, ['pair', target.hostPort, code.trim()], { timeoutMs: 30_000 });
    const result = parseAdbPairResult(stdout);
    return { ok: result.ok, message: result.message };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function connectDevice(
  sdk: ResolvedAndroidSdk,
  hostPort: string,
): Promise<AndroidActionResult> {
  const target = normalizeHostPort(hostPort);
  if (!target) return { ok: false, message: 'Enter an address and port, like 192.168.1.20:5555.' };

  try {
    const stdout = await runAdb(sdk, ['connect', target.hostPort], { timeoutMs: 20_000 });
    const result = parseAdbConnectResult(stdout);
    return { ok: result.ok, message: result.message };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function disconnectDevice(
  sdk: ResolvedAndroidSdk,
  serial: string,
): Promise<AndroidActionResult> {
  try {
    await runAdb(sdk, ['disconnect', serial]);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Moves a device that is plugged in over to Wi-Fi. A device already on USB is trusted, so this
 * needs no pairing code: `tcpip` then connect to whatever address the phone has on the network.
 */
export async function enableWireless(
  sdk: ResolvedAndroidSdk,
  serial: string,
): Promise<AndroidActionResult & { hostPort?: string }> {
  try {
    await runAdb(sdk, ['-s', serial, 'tcpip', String(ADB_CONNECT_PORT)], { timeoutMs: 30_000 });
    // The device needs a breath to restart adbd in TCP mode.
    await new Promise((done) => setTimeout(done, 1500));

    const route = await runAdb(sdk, ['-s', serial, 'shell', 'ip', 'route']);
    const ip = parseDeviceIpFromIpRoute(route);
    if (!ip) {
      return {
        ok: false,
        message: 'That device has no Wi-Fi address. Put it on the same network and try again.',
      };
    }

    const hostPort = `${ip}:${ADB_CONNECT_PORT}`;
    const connected = await connectDevice(sdk, hostPort);
    return connected.ok ? { ok: true, hostPort } : connected;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
