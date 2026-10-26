<?php
/**
 * Activation, deactivation and upgrades: the tables, the site key, the private data folder, the
 * guard mu-plugin with its option, and rescue.php's config.
 *
 * The tables and options keep the names 1.63 gave them, so a site that ran the 1.63 connector
 * goes on with its connections and history. Activating Runova Connector beside a 1.63 copy takes
 * over from it: the old copy is switched off without running its deactivation hook (that would
 * take the guard away) and its uninstall.php is disarmed, so deleting it later keeps the tables.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector;

use Runova\Connector\Guard\GuardInstaller;
use Runova\Connector\Guard\GuardState;
use Runova\Connector\Guard\Rescue;
use Runova\Connector\Support\DataDir;
use Runova\Connector\Support\Options;
use Runova\Connector\Update\LayoutMigration;
use Runova\Connector\Update\WpLayoutHost;

final class Activator
{
    const DB_VERSION_OPTION = Legacy::OPTION_PREFIX . 'db_version';

    /** What a disarmed 1.63 uninstall.php says instead of dropping the tables. */
    const DISARMED_UNINSTALL = "<?php\n// Runova Connector took over from this copy and uses its tables, so deleting it removes only its files.\n";

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
        self::takeOver();
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
        // Only a stat while there is no old folder left: the option is read once there is one.
        if (Layout::current() === Layout::RUNOVA && Layout::otherExists(dirname(RUNOVA_CONNECTOR_FILE))) {
            LayoutMigration::cleanUp(new WpLayoutHost(), time());
        }
    }

    /**
     * Creates or updates the tables. Never while a copy in the other layout is on disk and the
     * tables already exist: that copy may be older, and it would put its own schema back.
     */
    public static function installSchema(): void
    {
        global $wpdb;
        if (Options::get(self::DB_VERSION_OPTION) && Layout::otherExists(dirname(RUNOVA_CONNECTOR_FILE))) {
            return;
        }
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

    /** Switches off a 1.63 copy that is still active, the way LayoutMigration would. */
    private static function takeOver(): void
    {
        $dir = dirname(RUNOVA_CONNECTOR_FILE);
        if (Layout::of($dir) !== Layout::RUNOVA || !Layout::otherExists($dir)) {
            return;
        }
        $other = Layout::otherDir($dir);
        (new WpLayoutHost())->deactivate(Legacy::BASENAME);
        $uninstall = $other . '/uninstall.php';
        if (is_file($uninstall) && is_writable($uninstall)) {
            GuardInstaller::write($uninstall, self::DISARMED_UNINSTALL);
        }
    }
}
