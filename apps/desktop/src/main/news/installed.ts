import { CLI_REGISTRY, type DevDetection, type DevItemId, type InstalledCli } from '@runova/core';
import {
  DETECTABLE_TECHNOLOGIES,
  type InstalledTool,
  type TechnologySlug,
} from '../../shared/newsTypes';

/**
 * The tools the news matcher compares against, from what the app already knows: its own versions
 * and the remembered results of Dev Setup and CLI Manager. Nothing here runs a command.
 */

export interface InstalledSources {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  /** Dev Setup's remembered detections by item id. A missing id was never probed. */
  devSetup: Partial<Record<string, DevDetection | undefined>>;
  /** CLI Manager's last sweep, or null when there has not been one yet. */
  clis: readonly InstalledCli[] | null;
}

/** Dev Setup items by the technology they stand for, in the order they are listed. */
const DEV_SETUP_TOOLS: { item: DevItemId; slug: TechnologySlug; label: string }[] = [
  { item: 'git', slug: 'git', label: 'Git' },
  { item: 'dotnet-sdk', slug: 'dotnet', label: '.NET SDK' },
  { item: 'docker-desktop', slug: 'docker', label: 'Docker' },
];

export const DEV_SETUP_NEWS_ITEMS: readonly DevItemId[] = [
  'node',
  ...DEV_SETUP_TOOLS.map((tool) => tool.item),
];

const SLUGS = new Set<string>(DETECTABLE_TECHNOLOGIES);
const CLI_NAMES = new Map(CLI_REGISTRY.map((entry) => [entry.id, entry.name]));

function foundVersion(detection: DevDetection | undefined): string | null {
  return detection?.state === 'found' && detection.version ? detection.version : null;
}

export function installedTools(sources: InstalledSources): InstalledTool[] {
  const tools: InstalledTool[] = [
    { slug: 'runova', version: sources.appVersion, label: 'Runova' },
    { slug: 'electron', version: sources.electronVersion, label: 'Electron (inside Runova)' },
  ];
  // The installed Node.js goes first so that, when both are affected, the badge names it.
  const node = foundVersion(sources.devSetup.node);
  if (node) tools.push({ slug: 'nodejs', version: node, label: 'Node.js' });
  tools.push({ slug: 'nodejs', version: sources.nodeVersion, label: 'Node.js (inside Runova)' });

  for (const tool of DEV_SETUP_TOOLS) {
    const version = foundVersion(sources.devSetup[tool.item]);
    if (version) tools.push({ slug: tool.slug, version, label: tool.label });
  }

  for (const cli of sources.clis ?? []) {
    if (!cli.installed || !cli.version || !SLUGS.has(cli.id)) continue;
    tools.push({
      slug: cli.id as TechnologySlug,
      version: cli.version,
      label: CLI_NAMES.get(cli.id) ?? cli.id,
    });
  }
  return tools;
}
