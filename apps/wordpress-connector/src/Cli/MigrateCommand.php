<?php
/**
 * `wp runova migrate`.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Cli;

use Runova\Connector\Http\ApiError;
use Runova\Connector\Plugin;

/**
 * Moves the connector into its own folder, runova-connector/.
 */
final class MigrateCommand
{
    /**
     * Moves the connector from the folder it had before the rename to runova-connector/, the
     * same way the Runova app does after updating it. Use it when the app cannot reach the site.
     * The site health-checks itself afterwards and puts everything back when it fails.
     *
     * ## EXAMPLES
     *
     *     wp runova migrate
     *
     * @when after_wp_load
     *
     * @param string[] $args
     * @param array<string, string|bool> $assoc
     */
    public function __invoke($args, $assoc): void
    {
        try {
            $result = Plugin::layoutMigration()->migrate(null, 'wp-cli');
        } catch (ApiError $error) {
            \WP_CLI::error($error->getMessage());
            return;
        }
        if ($result['state'] === 'current') {
            \WP_CLI::success('The connector already runs from its own folder.');
            return;
        }
        if ($result['state'] === 'rolledBack') {
            \WP_CLI::error('The site failed its health check in the new folder, so the connector stays where it was.');
            return;
        }
        \WP_CLI::success('Moved the connector to runova-connector/. The old folder is removed in a few minutes.');
    }
}
