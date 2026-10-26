import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LEGACY_MCP_SERVER_NAME, LEGACY_PROJECT_DIR } from '@runova/core';

/**
 * The server name is part of the contract with the agent: its tools show up to the agent as
 * `mcp__runova__...`. Projects set up before the rename have the entry under the old name;
 * {@link moveLegacyRunProposals} replaces it.
 */
export const RUN_COMMANDS_SERVER_NAME = 'runova';
export const RUN_COMMANDS_SCRIPT_NAME = 'run-commands-mcp.cjs';

interface McpJson {
  mcpServers?: Record<string, { command?: unknown; args?: unknown }>;
  [key: string]: unknown;
}

export function runCommandsScriptPath(folder: string): string {
  return join(folder, '.runova', RUN_COMMANDS_SCRIPT_NAME);
}

function mcpJsonPath(folder: string): string {
  return join(folder, '.mcp.json');
}

function requireFolder(folder: string): void {
  // An empty folder would make these paths relative, so they would land in the working directory.
  if (folder.trim() === '') throw new Error('This project has no folder.');
}

/** Missing `.mcp.json` reads as an empty one. A file that exists but is not JSON is an error. */
async function readMcpJson(folder: string): Promise<McpJson | null> {
  let raw: string;
  try {
    raw = await readFile(mcpJsonPath(folder), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as McpJson;
  } catch {
    // Reported below: a file we cannot read is never overwritten.
  }
  return null;
}

function isOurEntry(entry: { args?: unknown } | undefined, scriptPath: string): boolean {
  return Array.isArray(entry?.args) && entry.args[0] === scriptPath;
}

export async function isRunProposalsEnabled(folder: string): Promise<boolean> {
  if (folder.trim() === '') return false;
  const config = await readMcpJson(folder).catch(() => null);
  const entry = config?.mcpServers?.[RUN_COMMANDS_SERVER_NAME];
  if (!entry || !isOurEntry(entry, runCommandsScriptPath(folder))) return false;
  try {
    await readFile(runCommandsScriptPath(folder), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** Writes the bridge script and adds its server entry, leaving every other entry as it is. */
export async function enableRunProposals(folder: string, scriptSource: string): Promise<void> {
  requireFolder(folder);
  const config = await readMcpJson(folder);
  if (!config) throw new Error('.mcp.json is not valid JSON, so it was left as it was.');

  const scriptPath = runCommandsScriptPath(folder);
  const existing = config.mcpServers?.[RUN_COMMANDS_SERVER_NAME];
  if (existing && !isOurEntry(existing, scriptPath)) {
    throw new Error(
      "The project's .mcp.json already has a 'runova' server that Runova did not write, so it was left as it was.",
    );
  }

  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, scriptSource, 'utf-8');
  config.mcpServers = {
    ...(config.mcpServers ?? {}),
    [RUN_COMMANDS_SERVER_NAME]: { command: 'node', args: [scriptPath] },
  };
  await writeFile(mcpJsonPath(folder), JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * A project set up before the rename has the bridge under the old server name, pointing at a
 * script in the old project folder (which has moved to `.runova` by now). Swaps that entry for
 * the current one and rewrites the script. Returns whether there was one; anything that isn't
 * ours is left alone.
 */
export async function moveLegacyRunProposals(
  folder: string,
  scriptSource: string,
): Promise<boolean> {
  if (folder.trim() === '') return false;
  const config = await readMcpJson(folder).catch(() => null);
  const legacy = config?.mcpServers?.[LEGACY_MCP_SERVER_NAME];
  const legacyScript = join(folder, LEGACY_PROJECT_DIR, RUN_COMMANDS_SCRIPT_NAME);
  if (!config || !legacy) return false;
  if (!isOurEntry(legacy, legacyScript) && !isOurEntry(legacy, runCommandsScriptPath(folder))) {
    return false;
  }
  const { [LEGACY_MCP_SERVER_NAME]: _removed, ...others } = config.mcpServers ?? {};
  await writeFile(
    mcpJsonPath(folder),
    JSON.stringify({ ...config, mcpServers: others }, null, 2),
    'utf-8',
  );
  await enableRunProposals(folder, scriptSource);
  return true;
}

/** Removes only the entry and script this module wrote. Anything else in the folder is left alone. */
export async function disableRunProposals(folder: string): Promise<void> {
  requireFolder(folder);
  const scriptPath = runCommandsScriptPath(folder);
  const config = await readMcpJson(folder).catch(() => null);
  const entry = config?.mcpServers?.[RUN_COMMANDS_SERVER_NAME];
  if (config && entry && isOurEntry(entry, scriptPath)) {
    const { [RUN_COMMANDS_SERVER_NAME]: _removed, ...others } = config.mcpServers ?? {};
    await writeFile(
      mcpJsonPath(folder),
      JSON.stringify({ ...config, mcpServers: others }, null, 2),
      'utf-8',
    );
  }
  await rm(scriptPath, { force: true });
}
