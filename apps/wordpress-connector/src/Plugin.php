<?php
/**
 * Wires the plugin into WordPress and builds its services on first use, so ordinary page loads
 * pay for nothing but a few hook registrations.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector;

use Runova\Connector\Admin\AdminPage;
use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Auth\KeyService;
use Runova\Connector\Auth\SiteMove;
use Runova\Connector\Cli\ConnectionsCommand;
use Runova\Connector\Cli\DeploysCommand;
use Runova\Connector\Cli\KeyCommand;
use Runova\Connector\Cli\MigrateCommand;
use Runova\Connector\Cli\RescueCommand;
use Runova\Connector\Cli\StatusCommand;
use Runova\Connector\Crypto\SiteKeys;
use Runova\Connector\Deploy\DeployService;
use Runova\Connector\Env\Environment;
use Runova\Connector\Env\WordPressEnvironment;
use Runova\Connector\Http\Dispatcher;
use Runova\Connector\Http\Transport;
use Runova\Connector\Routes\Handlers;
use Runova\Connector\Storage\Storage;
use Runova\Connector\Storage\WpdbStorage;
use Runova\Connector\Update\LayoutMigration;
use Runova\Connector\Update\WpLayoutHost;

final class Plugin
{
    /** @var Storage|null */
    private static $storage = null;

    /** @var Environment|null */
    private static $environment = null;

    /** @var SiteKeys|null */
    private static $keys = null;

    public static function boot(): void
    {
        if (Transport::looksLikeOurs()) {
            Transport::prepareEarly();
        }
        add_action('plugins_loaded', array(self::class, 'init'));
    }

    public static function init(): void
    {
        $cli = defined('WP_CLI') && WP_CLI && class_exists('WP_CLI');
        // The schema check reads an option that is not autoloaded, so visitors' page views skip it.
        if (is_admin() || $cli || Transport::looksLikeOurs()) {
            Activator::maybeUpgrade();
        }
        Transport::register();
        add_action(LayoutMigration::CRON_HOOK, array(self::class, 'cleanUpLayout'));
        if (is_admin()) {
            AdminPage::register();
        }
        if ($cli) {
            // The old command name keeps the scripts site owners wrote for 1.63 working.
            foreach (array('runova', Legacy::CLI_COMMAND) as $name) {
                \WP_CLI::add_command($name . ' key', KeyCommand::class);
                \WP_CLI::add_command($name . ' connections', ConnectionsCommand::class);
                \WP_CLI::add_command($name . ' deploys', DeploysCommand::class);
                \WP_CLI::add_command($name . ' status', StatusCommand::class);
                \WP_CLI::add_command($name . ' migrate', MigrateCommand::class);
                // The guard registers `wp runova rescue` so it works even with --skip-plugins;
                // without a guard the plugin does it.
                if (!defined('RUNOVA_CONNECTOR_GUARD') && !defined(Legacy::GUARD_CONSTANT)) {
                    \WP_CLI::add_command($name . ' rescue', RescueCommand::class);
                }
            }
        }
    }

    /** WP-Cron, after a move to the Runova layout: the old folder's grace period is over. */
    public static function cleanUpLayout(): void
    {
        LayoutMigration::cleanUp(new WpLayoutHost(), time());
    }

    public static function layoutMigration(): LayoutMigration
    {
        return new LayoutMigration(self::environment(), self::audit(), self::deployService(), new WpLayoutHost());
    }

    public static function storage(): Storage
    {
        if (self::$storage === null) {
            global $wpdb;
            self::$storage = new WpdbStorage($wpdb);
        }
        return self::$storage;
    }

    public static function environment(): Environment
    {
        if (self::$environment === null) {
            self::$environment = new WordPressEnvironment();
        }
        return self::$environment;
    }

    public static function siteKeys(): SiteKeys
    {
        if (self::$keys === null) {
            $home = is_multisite() ? get_blog_option(get_main_site_id(), 'home') : get_option('home');
            self::$keys = SiteKeys::load((string) $home, array(self::class, 'siteMoved'));
        }
        return self::$keys;
    }

    /** The site key was renewed because the address changed: nothing paired with the old one works. */
    public static function siteMoved(string $from, string $to): void
    {
        SiteMove::apply(self::storage(), time(), $from, $to);
    }

    public static function audit(): AuditLog
    {
        return new AuditLog(self::storage());
    }

    public static function keyService(): KeyService
    {
        return new KeyService(self::storage(), self::environment(), self::siteKeys(), self::audit());
    }

    public static function dispatcher(): Dispatcher
    {
        $storage = self::storage();
        $env = self::environment();
        return new Dispatcher($storage, $env, self::siteKeys(), Handlers::all($storage, $env), array(self::class, 'logError'));
    }

    /** Only the rescue routes, for the guard (before regular plugins load). */
    public static function rescueDispatcher(): Dispatcher
    {
        $storage = self::storage();
        $env = self::environment();
        return new Dispatcher($storage, $env, self::siteKeys(), Handlers::rescue($storage, $env), array(self::class, 'logError'));
    }

    public static function deployService(): DeployService
    {
        return new DeployService(self::storage(), self::environment(), self::audit());
    }

    public static function logError(\Throwable $error): void
    {
        // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- the site owner's only window into a failed call.
        error_log('Runova Connector: ' . get_class($error) . ': ' . $error->getMessage() . ' in ' . $error->getFile() . ':' . $error->getLine());
    }
}
