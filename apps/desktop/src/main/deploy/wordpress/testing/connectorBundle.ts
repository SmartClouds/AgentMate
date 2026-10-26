import { createHash } from 'node:crypto';
import {
  WP_CONNECTOR_VERSION,
  WP_LEGACY_CONNECTOR_MAIN,
  WP_LEGACY_CONNECTOR_NAME,
  WP_LEGACY_VERSION_CONSTANT,
} from '@runova/core';
import type { ConnectorBundle } from '../connectorBundle';

/** A small stand-in for the shipped connector, in the shape the update reads it. */
export function testConnectorBundle(version: string = WP_CONNECTOR_VERSION): ConnectorBundle {
  const sources: Record<string, string> = {
    'runova-connector.php': `<?php
/**
 * Plugin Name:       Runova Connector
 * Version:           ${version}
 */
define('RUNOVA_CONNECTOR_VERSION', '${version}');
`,
    'readme.txt': `=== Runova Connector ===\nStable tag: ${version}\n`,
    'src/Plugin.php': '<?php\nnamespace Runova\\Connector;\nfinal class Plugin {}\n',
  };
  const files = Object.keys(sources)
    .sort()
    .map((path) => {
      const bytes = Buffer.from(sources[path], 'utf-8');
      return {
        path,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
      };
    });
  return { version, files, totalBytes: files.reduce((sum, file) => sum + file.size, 0) };
}

/** The bridge package in small: the 1.63 main file and the Runova one waiting in layout/. */
export function testBridgeBundle(version: string = WP_CONNECTOR_VERSION): ConnectorBundle {
  const runova = testConnectorBundle(version);
  const legacyMain = Buffer.from(
    `<?php
/**
 * Plugin Name:       ${WP_LEGACY_CONNECTOR_NAME}
 * Version:           ${version}
 */
define('${WP_LEGACY_VERSION_CONSTANT}', '${version}');
`,
    'utf-8',
  );
  const files = [
    ...runova.files.map((file) =>
      file.path === 'runova-connector.php'
        ? { ...file, path: 'layout/runova-connector.php' }
        : file,
    ),
    {
      path: WP_LEGACY_CONNECTOR_MAIN,
      size: legacyMain.length,
      sha256: createHash('sha256').update(legacyMain).digest('hex'),
      bytes: legacyMain,
    },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    version,
    package: 'bridge',
    files,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}
