import { copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WP_LEGACY_CONNECTOR_ZIP } from '@runova/core';
import type { DeployWordPressSaveZipResult } from '../../../shared/deployWordPressTypes';
import { wordPressError } from '../../../shared/wordpressErrors';

/**
 * The Runova Connector plugin zip that ships with the app (E19), saved wherever the user picks
 * so they can upload it in wp-admin. Packaged builds carry it in their resources; a development
 * run uses the one `node scripts/wordpress-connector.mjs build` writes.
 */

export const CONNECTOR_ZIP_NAME = 'runova-connector.zip';
/**
 * The bridge package, the same plugin in the folder 1.63 used: the only update a 1.63 site takes.
 * The app sends it to such a site, then asks the site to move to its own folder.
 */
export const BRIDGE_ZIP_NAME = WP_LEGACY_CONNECTOR_ZIP;

export interface ConnectorZipDeps {
  isPackaged: boolean;
  /** process.resourcesPath */
  resourcesPath: string;
  /** app.getAppPath(): apps/desktop in development. */
  appPath: string;
  /** Null when the user cancelled the dialog. */
  pickSavePath: (suggestedName: string) => Promise<string | null>;
  copy?: (from: string, to: string) => Promise<void>;
}

export function connectorZipPath(
  deps: Pick<ConnectorZipDeps, 'isPackaged' | 'resourcesPath' | 'appPath'>,
  name: string = CONNECTOR_ZIP_NAME,
): string {
  return deps.isPackaged
    ? join(deps.resourcesPath, 'wordpress-connector', name)
    : join(deps.appPath, '..', 'wordpress-connector', 'dist', name);
}

export async function saveConnectorZip(
  deps: ConnectorZipDeps,
): Promise<DeployWordPressSaveZipResult> {
  const source = connectorZipPath(deps);
  const found = await stat(source).catch(() => null);
  if (!found?.isFile()) {
    throw wordPressError(
      'internal',
      deps.isPackaged
        ? 'This build of Runova does not include the Runova Connector plugin. Download it from the Runova release page instead.'
        : 'The Runova Connector zip has not been built yet. Run "node scripts/wordpress-connector.mjs build" first.',
    );
  }
  const target = await deps.pickSavePath(CONNECTOR_ZIP_NAME);
  if (!target) return { saved: false };
  await (deps.copy ?? copyFile)(source, target);
  return { saved: true, path: target };
}
