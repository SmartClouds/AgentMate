<?php
/**
 * What the guard mu-plugin does once it sees a pending deploy, a rescue call or WP-CLI. It runs
 * before regular plugins load, so a plugin a deploy broke cannot stop it.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Guard;

use Runova\Connector\Cli\RescueCommand;
use Runova\Connector\Files\Paths;
use Runova\Connector\Http\Transport;
use Runova\Connector\Layout;
use Runova\Connector\Legacy;
use Runova\Connector\Plugin;
use Runova\Connector\Protocol;

final class GuardRuntime
{
    const FATAL = array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR);

    /** @var array{d: string, t: int, f: string[]}|null */
    private static $state = null;

    public static function run(string $pluginDir, string $rawState, bool $maybeRescue): void
    {
        if (!defined('RUNOVA_CONNECTOR_FILE')) {
            define('RUNOVA_CONNECTOR_FILE', Layout::mainFile($pluginDir));
        }
        if (defined('WP_CLI') && WP_CLI && class_exists('WP_CLI')) {
            \WP_CLI::add_command('runova rescue', RescueCommand::class);
            \WP_CLI::add_command(Legacy::CLI_COMMAND . ' rescue', RescueCommand::class);
        }
        self::$state = GuardState::decode($rawState);
        if (self::$state !== null) {
            register_shutdown_function(array(self::class, 'shutdown'));
            if (time() > self::$state['t']) {
                self::safely(function () {
                    Plugin::deployService()->checkPending();
                });
            }
        }
        if ($maybeRescue) {
            $route = self::rescueRoute();
            if ($route !== null) {
                self::serve($route);
            }
        }
    }

    /** Rolls the deploy back when PHP died of a fatal error in a file it changed. */
    public static function shutdown(): void
    {
        $error = error_get_last();
        if (self::$state === null || !is_array($error) || !in_array($error['type'], self::FATAL, true)) {
            return;
        }
        $file = (string) $error['file'];
        $real = realpath($file);
        foreach (self::$state['f'] as $changed) {
            if (Paths::same($changed, $file) || ($real !== false && Paths::same($changed, $real))) {
                self::safely(function () use ($file) {
                    Plugin::deployService()->onFatal($file);
                });
                return;
            }
        }
    }

    /**
     * The rescue route this request is for, from a REST URL, ?rest_route= or admin-ajax.
     */
    public static function rescueRoute(): ?string
    {
        $found = self::rescueRequest();
        return $found === null ? null : $found['route'];
    }

    /**
     * The rescue route and the signing prefix its entry point suggests (the old one for the
     * namespace and action 1.63 desktops call), or null.
     *
     * @return array{route: string, prefix: string}|null
     */
    private static function rescueRequest(): ?array
    {
        // phpcs:disable WordPress.Security.NonceVerification.Recommended -- the call is authenticated by its signature.
        $uri = isset($_SERVER['REQUEST_URI']) ? rawurldecode(esc_url_raw(wp_unslash($_SERVER['REQUEST_URI']))) : '';
        $path = (string) wp_parse_url($uri, PHP_URL_PATH);
        foreach (Protocol::REST_NAMESPACES as $namespace) {
            $prefix = $namespace === Protocol::REST_NAMESPACE ? Protocol::PREFIX : Protocol::LEGACY_PREFIX;
            $pattern = '#^/' . preg_quote($namespace, '#') . '(/rescue/(?:status|rollback))/?$#D';
            if (isset($_GET['rest_route']) && is_string($_GET['rest_route']) && preg_match($pattern, sanitize_text_field(wp_unslash($_GET['rest_route'])), $match) === 1) {
                return array('route' => $match[1], 'prefix' => $prefix);
            }
            if (preg_match('#/' . preg_quote($namespace, '#') . '(/rescue/(?:status|rollback))/?$#D', $path, $match) === 1) {
                return array('route' => $match[1], 'prefix' => $prefix);
            }
        }
        $isAjax = substr($path, -strlen('/admin-ajax.php')) === '/admin-ajax.php';
        $action = isset($_GET['action']) && is_string($_GET['action']) ? sanitize_text_field(wp_unslash($_GET['action'])) : '';
        $route = isset($_GET['route']) && is_string($_GET['route']) ? sanitize_text_field(wp_unslash($_GET['route'])) : '';
        // phpcs:enable WordPress.Security.NonceVerification.Recommended
        if ($isAjax && in_array($action, Protocol::AJAX_ACTIONS, true) && in_array($route, array('/rescue/status', '/rescue/rollback'), true)) {
            return array('route' => $route, 'prefix' => $action === Protocol::AJAX_ACTION ? Protocol::PREFIX : Protocol::LEGACY_PREFIX);
        }
        return null;
    }

    private static function serve(string $route): void
    {
        if (!defined('DONOTCACHEPAGE')) {
            define('DONOTCACHEPAGE', true);
        }
        $found = self::rescueRequest();
        $response = Plugin::rescueDispatcher()->handle(Transport::incoming($route, $found === null ? Protocol::PREFIX : $found['prefix']));
        Transport::emit($response);
        exit;
    }

    private static function safely(callable $work): void
    {
        try {
            $work();
        } catch (\Throwable $error) {
            Plugin::logError($error);
        }
    }
}
