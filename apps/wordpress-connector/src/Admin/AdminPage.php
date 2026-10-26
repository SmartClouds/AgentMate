<?php
/**
 * Tools > Runova Connector (Network Admin > Settings on multisite), in tabs: Keys,
 * Connections, Deploys, Audit log and Status. Forms post back to the page and are handled on its
 * load hook, before any output, so refusals can answer 403. Revoke and roll back redirect after
 * the action; a new key is shown once, in the reply to the form that made it, and never stored
 * where this page could show it again.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Admin;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Guard\GuardInstaller;
use Runova\Connector\Info\StatusChecks;
use Runova\Connector\Layout;
use Runova\Connector\Plugin;

final class AdminPage
{
    const SLUG = 'runova-connector';
    const TABS = array('keys', 'connections', 'deploys', 'audit', 'status');
    const AUDIT_PAGE = 50;

    /** @var array{key: string, expiresAt: int, scope: string}|null the key made by this request */
    private static $created = null;

    /** @var string|null */
    private static $error = null;

    public static function register(): void
    {
        if (is_multisite()) {
            add_action('network_admin_menu', array(self::class, 'addNetworkMenu'));
            return;
        }
        add_action('admin_menu', array(self::class, 'addMenu'));
    }

    public static function addMenu(): void
    {
        $hook = add_management_page(
            __('Runova Connector', 'runova-connector'),
            __('Runova Connector', 'runova-connector'),
            'manage_options',
            self::SLUG,
            array(self::class, 'render')
        );
        if (is_string($hook)) {
            add_action('load-' . $hook, array(self::class, 'load'));
        }
    }

    public static function addNetworkMenu(): void
    {
        $hook = add_submenu_page(
            'settings.php',
            __('Runova Connector', 'runova-connector'),
            __('Runova Connector', 'runova-connector'),
            'manage_network_options',
            self::SLUG,
            array(self::class, 'render')
        );
        if (is_string($hook)) {
            add_action('load-' . $hook, array(self::class, 'load'));
        }
    }

    /**
     * @param array<string, string|int> $args
     */
    public static function url(array $args = array()): string
    {
        $base = is_multisite() ? network_admin_url('settings.php') : admin_url('tools.php');
        return add_query_arg(array_merge(array('page' => self::SLUG), $args), $base);
    }

    private static function actions(): AdminActions
    {
        return new AdminActions(Plugin::storage(), Plugin::environment(), new WpAdminContext(), array(Plugin::class, 'keyService'), Plugin::deployService(), array(Plugin::class, 'layoutMigration'));
    }

    /** The page's one script: a fixed string, so nothing a user typed can end up in it. */
    public static function enqueue(): void
    {
        wp_register_script('runova-connector-admin', false, array(), RUNOVA_CONNECTOR_VERSION, true);
        wp_add_inline_script('runova-connector-admin', AdminViews::SCRIPT);
        wp_enqueue_script('runova-connector-admin');
    }

    /** Handles a posted form before the page prints anything. */
    public static function load(): void
    {
        add_action('admin_enqueue_scripts', array(self::class, 'enqueue'));
        $method = isset($_SERVER['REQUEST_METHOD']) ? strtoupper(sanitize_text_field(wp_unslash($_SERVER['REQUEST_METHOD']))) : '';
        // phpcs:disable WordPress.Security.NonceVerification.Missing -- AdminActions::run checks the capability and then the nonce first thing.
        if ($method !== 'POST' || !isset($_POST['runova_connector_action'])) {
            return;
        }
        $action = sanitize_key(wp_unslash($_POST['runova_connector_action']));
        $fields = array(
            'scope' => isset($_POST['scope']) ? sanitize_key(wp_unslash($_POST['scope'])) : 'read',
            'label' => isset($_POST['label']) ? sanitize_text_field(wp_unslash($_POST['label'])) : '',
            'expires' => isset($_POST['expires']) ? absint(wp_unslash($_POST['expires'])) : 0,
            'id' => isset($_POST['id']) ? sanitize_text_field(wp_unslash($_POST['id'])) : '',
        );
        // phpcs:enable WordPress.Security.NonceVerification.Missing
        try {
            $result = self::actions()->run($action, $fields);
        } catch (\Throwable $error) {
            Plugin::logError($error);
            $result = array('status' => 'error', 'code' => 'failed');
        }
        if ($result['status'] === 'refused') {
            $message = $result['code'] === 'nonce'
                ? __('This form has expired. Go back, reload the page and try again.', 'runova-connector')
                : __('You do not have permission to do that.', 'runova-connector');
            wp_die(esc_html($message), esc_html__('Not allowed', 'runova-connector'), array('response' => 403, 'back_link' => true));
        }
        if ($action === AdminActions::CREATE_KEY) {
            if ($result['status'] === 'done') {
                self::$created = $result['data'];
            } else {
                self::$error = self::message($result['code'], array());
            }
            // The page shows a secret: never cache it, never send it as a referrer.
            nocache_headers();
            header('Referrer-Policy: no-referrer');
            return;
        }
        $tabs = array(AdminActions::REVOKE => 'connections', AdminActions::MIGRATE => 'status');
        $args = array('tab' => isset($tabs[$action]) ? $tabs[$action] : 'deploys', 'runova_notice' => $result['code']);
        foreach (array('restored', 'removed', 'count') as $number) {
            if (isset($result['data'][$number])) {
                $args[$number] = (int) $result['data'][$number];
            }
        }
        wp_safe_redirect(self::url($args));
        exit;
    }

    /**
     * Words for a result code.
     *
     * @param array<string, int> $numbers
     */
    public static function message(string $code, array $numbers): string
    {
        switch ($code) {
            case 'revoked':
                return __('The connection is revoked. Runova can no longer use it.', 'runova-connector');
            case 'alreadyRevoked':
                return __('That connection was already revoked.', 'runova-connector');
            case 'unknownConnection':
                return __('That connection no longer exists.', 'runova-connector');
            case 'rolledBack':
                /* translators: 1: files restored, 2: files removed */
                return sprintf(__('Rolled back: %1$d files restored, %2$d removed.', 'runova-connector'), isset($numbers['restored']) ? $numbers['restored'] : 0, isset($numbers['removed']) ? $numbers['removed'] : 0);
            case 'conflicts':
                /* translators: %d: number of files */
                return sprintf(__('Not rolled back: %d files changed after that deploy. Roll back from Runova, where you can review them.', 'runova-connector'), isset($numbers['count']) ? $numbers['count'] : 0);
            case 'notRollbackable':
                return __('That deploy cannot be rolled back any more.', 'runova-connector');
            case 'busy':
                return __('Another deploy is in progress. Try again in a minute.', 'runova-connector');
            case 'deployUnknown':
                return __('That deploy no longer exists.', 'runova-connector');
            case 'scope':
                return __('Choose read or write.', 'runova-connector');
            case 'expiry':
                return __('Choose how long the connection lasts from the list.', 'runova-connector');
            case 'label':
                return __('A label is up to 100 characters.', 'runova-connector');
            case 'moved':
                return __('Runova Connector now runs from its own folder. The old folder is removed in a few minutes.', 'runova-connector');
            case 'moveRolledBack':
                return __('The site failed its health check in the new folder, so the connector stays where it was.', 'runova-connector');
            case 'moveRefused':
                return __('The connector could not move to its new folder (the plugins or mu-plugins folder may not be writable). It keeps working where it is.', 'runova-connector');
        }
        return __('That did not work. The PHP error log has the details.', 'runova-connector');
    }

    public static function render(): void
    {
        $actions = self::actions();
        if (!current_user_can($actions->baseCapability())) {
            wp_die(esc_html__('You do not have permission to manage Runova Connector.', 'runova-connector'), '', array('response' => 403));
        }
        // phpcs:disable WordPress.Security.NonceVerification.Recommended -- reading which tab to show and a notice code to print.
        $tab = isset($_GET['tab']) ? sanitize_key(wp_unslash($_GET['tab'])) : 'keys';
        $tab = in_array($tab, self::TABS, true) ? $tab : 'keys';
        $notice = isset($_GET['runova_notice']) ? sanitize_key(wp_unslash($_GET['runova_notice'])) : '';
        $numbers = array();
        foreach (array('restored', 'removed', 'count') as $number) {
            if (isset($_GET[$number])) {
                $numbers[$number] = absint(wp_unslash($_GET[$number]));
            }
        }
        $before = isset($_GET['before']) ? absint(wp_unslash($_GET['before'])) : 0;
        // phpcs:enable WordPress.Security.NonceVerification.Recommended

        $urls = array();
        foreach (self::TABS as $name) {
            $urls[$name] = self::url(array('tab' => $name));
        }
        AdminViews::open($tab, $urls);
        if ($notice !== '') {
            $good = in_array($notice, array('revoked', 'alreadyRevoked', 'rolledBack', 'moved'), true);
            AdminViews::notice($good ? 'success' : 'error', self::message($notice, $numbers));
        }
        if (Layout::current() === Layout::BRIDGE) {
            AdminViews::moveBox($actions->canChangeCode());
        }
        $storage = Plugin::storage();
        $env = Plugin::environment();
        switch ($tab) {
            case 'connections':
                AdminViews::connections($storage->listConnections(), $env->now());
                break;
            case 'deploys':
                $service = Plugin::deployService();
                AdminViews::deploys($service->history(array('limit' => 20))['deploys'], $service->pending(), $actions->canChangeCode());
                break;
            case 'audit':
                $entries = (new AuditLog($storage))->entries(self::AUDIT_PAGE, $before > 0 ? $before : null);
                $older = count($entries) === self::AUDIT_PAGE ? self::url(array('tab' => 'audit', 'before' => $entries[count($entries) - 1]['id'])) : null;
                AdminViews::audit($entries, $older, $before > 0 ? $urls['audit'] : null);
                break;
            case 'status':
                if (!function_exists('get_plugin_data')) {
                    require_once ABSPATH . 'wp-admin/includes/plugin.php';
                }
                $header = get_plugin_data(RUNOVA_CONNECTOR_FILE, false, false);
                AdminViews::status(StatusChecks::run($env, $storage, array(
                    'headerVersion' => isset($header['Version']) ? (string) $header['Version'] : null,
                    'guardCurrent' => GuardInstaller::isCurrent(dirname(RUNOVA_CONNECTOR_FILE)),
                )));
                break;
            default:
                AdminViews::keys(self::$created, self::$error, $actions->canChangeCode());
        }
        AdminViews::close();
    }
}
