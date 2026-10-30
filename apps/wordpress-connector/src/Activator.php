<?php
/**
 * Activation, deactivation and upgrades: the tables, the site key, the private data folder, the
 * guard mu-plugin with its option, and rescue.php's config.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector;

use Runova\Connector\Guard\GuardInstaller;
use Runova\Connector\Guard\GuardState;
use Runova\Connector\Guard\Rescue;
use Runova\Connector\Support\DataDir;
use Runova\Connector\Support\Options;

final class Activator
{
    const DB_VERSION_OPTION = 'runova_connector_db_version';

    /**
     * @param bool $networkWide
     */
    public static function activate($networkWide = false): void
    {
        if (is_multisite() && !$networkWide) {
            wp_die(
                esc_html__('Runova Connector works for the whole network. Activate it from Network Admin > Plugins.', 'runova-connector'),
                esc_html__('Network activation needed', 'runova-connector'),
                array('back_link' => true)
            );
        }
        self::installSchema();
        Plugin::siteKeys();
        DataDir::ensure();
        self::installGuard();
    }

    /**
     * @param bool $networkWide
     */
    public static function deactivate($networkWide = false): void
    {
        // Unconfirmed code must not stay on the site once nothing guards it any more.
        try {
            Plugin::deployService()->abandonPending('The connector was deactivated.');
        } catch (\Throwable $error) {
            Plugin::logError($error);
        }
        GuardInstaller::uninstall();
        GuardState::delete();
    }

    /** Runs in wp-admin, WP-CLI and the connector's own requests; never on visitors' pages. */
    public static function maybeUpgrade(): void
    {
        if (Options::get(self::DB_VERSION_OPTION) !== Schema::VERSION) {
            self::installSchema();
        }
        self::installGuard();
    }

    /** Creates or updates the tables. */
    public static function installSchema(): void
    {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        dbDelta(Schema::sql($wpdb->base_prefix, $wpdb->get_charset_collate()));
        Options::update(self::DB_VERSION_OPTION, Schema::VERSION);
    }

    private static function installGuard(): void
    {
        $dir = dirname(RUNOVA_CONNECTOR_FILE);
        GuardState::ensure();
        GuardInstaller::install($dir);
        Rescue::writeConfig($dir);
    }
}
