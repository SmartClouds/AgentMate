import { LEGACY_CORE_NAMES } from '../coreLegacyNames';
import type {
  AssistantModeInfo,
  ExecApprovalNonce,
  ExecOutput,
  ExecRequest,
  JournalLine,
} from '../protocol/generated/Runova.ServerCore.Contracts';

/**
 * The core's exec stream and journal for main-process tests (E09). It keeps the core's rules in
 * small: a short allowlist of read-only commands that run unattended (from the assistant only in
 * auto-run mode), and anything else only with a signature, by the device the test registers,
 * over the core's message for a nonce it issued (single use, two minutes). The test hands in the
 * signature check, since this file is shared with the renderer, which has no node:crypto.
 */

export const FAKE_EXEC_NEEDS_APPROVAL = 'This command needs your approval before it runs.';
export const FAKE_EXEC_APPROVAL_INVALID =
  'The approval for this command is not valid. Approve it again.';

const LIFETIME_MS = 120_000;
const ALLOWLIST =
  /^(?:docker (?:ps|logs|inspect)|systemctl status|journalctl|df|free|ss -tlnp|uptime)(?: [A-Za-z0-9._/:=,@+-]+)*$/;

export interface FakeExecRun {
  command: string;
  fromAssistant: boolean;
  how: 'allowlist' | 'signed';
}

export interface FakeDevice {
  deviceId: string;
  sessionId: string;
  /** True when `signature` (base64) is the device's over `message`. */
  verify: (message: string, signature: string) => boolean;
}

export function fakeExecMessage(
  nonceId: string,
  nonce: string,
  deviceId: string,
  sessionId: string,
  command: string,
  prefix = 'runova-core/exec/v1',
): string {
  return [prefix, nonceId, nonce, deviceId, sessionId, command].join('\n');
}

/** Like the core, either prefix: an app signs with the old one until it knows the core is new. */
const EXEC_PREFIXES = ['runova-core/exec/v1', LEGACY_CORE_NAMES.execPrefix];

export class FakeAssistant {
  autoRun = false;
  device: FakeDevice | null = null;
  readonly ran: FakeExecRun[] = [];
  /** Commands refused, with why. */
  readonly refused: Array<{ command: string; reason: string }> = [];
  /** What a command prints; anything else prints that it ran. */
  readonly outputs = new Map<string, { lines: string[]; exitCode: number }>();
  /** A journal line list per unit. */
  readonly journal = new Map<string, JournalLine[]>();
  private readonly nonces = new Map<string, { nonce: string; expiresAt: number }>();
  private count = 0;

  constructor(private readonly now: () => number) {}

  mode(): AssistantModeInfo {
    return {
      mode: this.autoRun ? 'autoRunDiagnostics' : 'approveEveryCommand',
      allowlist: ['docker ps', 'docker logs', 'journalctl', 'df'],
    };
  }

  issue(): ExecApprovalNonce {
    this.count += 1;
    const nonceId = `00000000-0000-4000-8000-${String(this.count).padStart(12, '0')}`;
    const nonce = `nonce-${this.count}`;
    const expiresAtUnixMs = this.now() + LIFETIME_MS;
    this.nonces.set(nonceId, { nonce, expiresAt: expiresAtUnixMs });
    return { nonceId, nonce, expiresAtUnixMs };
  }

  /** Decides as the core does; returns the error message when it refuses. */
  admit(request: ExecRequest): string | null {
    const { command, approval } = request;
    if (approval) {
      const issued = this.nonces.get(approval.nonceId);
      this.nonces.delete(approval.nonceId);
      const valid =
        issued !== undefined &&
        issued.expiresAt > this.now() &&
        this.device !== null &&
        EXEC_PREFIXES.some((prefix) =>
          this.device?.verify(
            fakeExecMessage(
              approval.nonceId,
              issued.nonce,
              this.device.deviceId,
              this.device.sessionId,
              command,
              prefix,
            ),
            approval.signature,
          ),
        );
      if (!valid) return this.refuse(command, FAKE_EXEC_APPROVAL_INVALID);
      this.ran.push({ command, fromAssistant: request.fromAssistant, how: 'signed' });
      return null;
    }
    if (ALLOWLIST.test(command) && (!request.fromAssistant || this.autoRun)) {
      this.ran.push({ command, fromAssistant: request.fromAssistant, how: 'allowlist' });
      return null;
    }
    return this.refuse(command, FAKE_EXEC_NEEDS_APPROVAL);
  }

  output(command: string): ExecOutput[] {
    const known = this.outputs.get(command);
    const lines = known?.lines ?? [`ran: ${command}`];
    return [
      {
        lines: lines.map((text) => ({ stream: 'out', text })),
        ended: false,
        timedOut: false,
        truncated: false,
      },
      { lines: [], ended: true, exitCode: known?.exitCode ?? 0, timedOut: false, truncated: false },
    ];
  }

  private refuse(command: string, reason: string): string {
    this.refused.push({ command, reason });
    return reason;
  }
}
