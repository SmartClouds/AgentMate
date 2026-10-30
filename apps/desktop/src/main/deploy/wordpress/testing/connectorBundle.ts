import { createHash } from 'node:crypto';
import { WP_CONNECTOR_VERSION } from '@runova/core';
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
