<?php
/**
 * `wp runova deploys list`.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Cli;

use Runova\Connector\Plugin;

/**
 * Shows the deploys Runova made on this site.
 */
final class DeploysCommand
{
    /**
     * Lists recent deploys, newest first.
     *
     * ## OPTIONS
     *
     * [--limit=<number>]
     * : How many, up to 50.
     * ---
     * default: 20
     * ---
     *
     * [--format=<format>]
     * : How to print them.
     * ---
     * default: table
     * options:
     *   - table
     *   - json
     *   - csv
     *   - yaml
     * ---
     *
     * @subcommand list
     * @when after_wp_load
     *
     * @param string[] $args
     * @param array<string, string|bool> $assoc
     */
    public function list_($args, $assoc): void
    {
        $limit = isset($assoc['limit']) ? (int) $assoc['limit'] : 20;
        if ($limit < 1 || $limit > 50) {
            \WP_CLI::error('--limit is a number from 1 to 50.');
            return;
        }
        $rows = array();
        foreach (Plugin::deployService()->history(array('limit' => $limit))['deploys'] as $record) {
            $rows[] = array(
                'id' => $record['deployId'],
                'label' => $record['label'],
                'state' => $record['state'] . (isset($record['reason']) ? ' (' . $record['reason'] . ')' : ''),
                'started' => gmdate('Y-m-d H:i:s', $record['startedAt']) . ' UTC',
                'by' => $record['connectionLabel'],
                'puts' => $record['puts'],
                'deletes' => $record['deletes'],
                'can_roll_back' => $record['canRollback'] ? 'yes' : 'no',
            );
        }
        \WP_CLI\Utils\format_items(
            isset($assoc['format']) ? (string) $assoc['format'] : 'table',
            $rows,
            array('id', 'label', 'state', 'started', 'by', 'puts', 'deletes', 'can_roll_back')
        );
    }
}
