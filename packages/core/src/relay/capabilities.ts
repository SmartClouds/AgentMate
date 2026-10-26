import { cliLaunchOptions } from '../cli/launchDefaults.js';

/** The mode a relay leg switches to once its plan is approved. */
export type RelayAfterPlanMode = 'auto' | 'acceptEdits';

/**
 * What the relay can do with a CLI. Claude Code reports through hooks and takes a per-launch
 * settings file and MCP config, so it gets the whole relay. The others run legs and finish them
 * from the handoff file and their output going quiet.
 */
export interface RelayCliCapabilities {
  cliId: string;
  /** The CLI has a plan mode to start a leg in. */
  planMode: boolean;
  /** The relay can approve a finished plan and move the session on to executing by itself. */
  planAutoSwitch: boolean;
  afterPlanModes: readonly RelayAfterPlanMode[];
  /** How a leg is told its context budget is nearly used: a hook, an MCP status call, or not. */
  contextGuard: 'hook' | 'mcp' | 'none';
  /** A Stop hook can hold the session until it has written its handoff. */
  stopGate: boolean;
  /** The live context of a session can be read, for the fuel ring and the guard. */
  contextMeter: boolean;
  /** How the Runova relay MCP server is handed to the CLI at launch, if it can be. */
  mcp: 'claude' | 'codex' | 'copilot' | null;
  /** Exact: the CLI says when its turn ends. Heuristic: the relay waits for its output to settle. */
  completion: 'exact' | 'heuristic';
}

const FULL: Omit<RelayCliCapabilities, 'cliId' | 'planMode'> = {
  planAutoSwitch: true,
  afterPlanModes: ['auto', 'acceptEdits'],
  contextGuard: 'hook',
  stopGate: true,
  contextMeter: true,
  mcp: 'claude',
  completion: 'exact',
};

const BASIC: Omit<RelayCliCapabilities, 'cliId' | 'planMode'> = {
  planAutoSwitch: false,
  afterPlanModes: [],
  contextGuard: 'none',
  stopGate: false,
  contextMeter: false,
  mcp: null,
  completion: 'heuristic',
};

/** Per CLI, what differs from the basic set. Verified against the real CLIs in E26 T0. */
const OVERRIDES: Record<string, Partial<RelayCliCapabilities>> = {
  'claude-code': FULL,
  // Both take an MCP server for one session from the command line (`-c mcp_servers.*`,
  // `--additional-mcp-config`), so a leg can ask how much budget is left and report its end.
  'codex-cli': { mcp: 'codex', contextGuard: 'mcp' },
  'copilot-cli': { mcp: 'copilot', contextGuard: 'mcp' },
};

/** The flags that start this CLI in plan mode, or null when it has none. */
export function relayPlanArgs(cliId: string): string[] | null {
  const plan = cliLaunchOptions(cliId)?.modes.find((mode) => mode.id === 'plan');
  return plan ? [...plan.args] : null;
}

export function relayCapabilities(cliId: string): RelayCliCapabilities {
  const planMode = relayPlanArgs(cliId) !== null;
  return { cliId, planMode, ...BASIC, ...OVERRIDES[cliId] };
}
