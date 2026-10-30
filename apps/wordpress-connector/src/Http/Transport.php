<?php
/**
 * The ways a request reaches the dispatcher:
 *  - REST: POST <rest base>/runova/v1/<route> (pretty permalinks or ?rest_route=);
 *  - admin-ajax: POST admin-ajax.php?action=runova_connector&route=<route>, for sites whose
 *    REST API is blocked. Logged in or not makes no difference: auth is the signature.
 * Either way the reply is raw bytes sent after every output buffer is thrown away, with caching
 * turned off for every layer we know of.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

use Runova\Connector\Plugin;
use Runova\Connector\Protocol;

// phpcs:disable WordPress.Security.NonceVerification -- requests are authenticated by their Ed25519 signature, not a WordPress nonce.

final class Transport
{
    /** @var OutgoingResponse|null a REST reply waiting for rest_pre_serve_request */
    private static $pending = null;

    public static function register(): void
    {
        add_action('rest_api_init', array(self::class, 'registerRoutes'));
        add_filter('rest_authentication_errors', array(self::class, 'clearAuthErrors'), 9999);
        add_filter('rest_pre_serve_request', array(self::class, 'serveRest'), 9999, 4);
        add_action('wp_ajax_' . Protocol::AJAX_ACTION, array(self::class, 'serveAjax'));
        add_action('wp_ajax_nopriv_' . Protocol::AJAX_ACTION, array(self::class, 'serveAjax'));
        // The health checks' second probe: admin-ajax answers only if every plugin still loads.
        add_action('wp_ajax_' . Protocol::AJAX_ACTION . '_ping', array(self::class, 'ping'));
        add_action('wp_ajax_nopriv_' . Protocol::AJAX_ACTION . '_ping', array(self::class, 'ping'));
    }

    /** True for a POST that is plainly for us, checked as early as the plugin loads. */
    public static function looksLikeOurs(): bool
    {
        $method = isset($_SERVER['REQUEST_METHOD']) ? strtoupper(sanitize_text_field(wp_unslash($_SERVER['REQUEST_METHOD']))) : '';
        if ($method !== 'POST') {
            return false;
        }
        // Only a hint for buffering early; the route that counts comes from WordPress later.
        $uri = isset($_SERVER['REQUEST_URI']) ? rawurldecode(esc_url_raw(wp_unslash($_SERVER['REQUEST_URI']))) : '';
        if (stripos($uri, '/' . Protocol::REST_NAMESPACE . '/') !== false) {
            return true;
        }
        return isset($_GET['action']) && $_GET['action'] === Protocol::AJAX_ACTION;
    }

    /** Called at load time for our requests: buffer stray output and keep page caches away. */
    public static function prepareEarly(): void
    {
        if (!defined('DONOTCACHEPAGE')) {
            define('DONOTCACHEPAGE', true);
        }
        ob_start();
    }

    public static function registerRoutes(): void
    {
        foreach (Protocol::ROUTES as $route) {
            register_rest_route(
                Protocol::REST_NAMESPACE,
                $route,
                array(
                    'methods' => 'POST',
                    // The route that gets signed is this constant, never anything read from the URL.
                    'callback' => function () use ($route) {
                        return Transport::handleRest($route);
                    },
                    // Our own signature check runs inside the callback.
                    'permission_callback' => '__return_true',
                )
            );
        }
    }

    /**
     * @return \WP_REST_Response
     */
    public static function handleRest(string $route)
    {
        $response = Plugin::dispatcher()->handle(self::incoming($route));
        self::$pending = $response;
        return new \WP_REST_Response(null, $response->status);
    }

    /**
     * Security plugins often refuse REST calls from logged-out users. Our routes do their own auth,
     * so their errors are cleared for our namespace only, and only here, as late as possible.
     *
     * @param mixed $result
     * @return mixed
     */
    public static function clearAuthErrors($result)
    {
        if (!is_wp_error($result) || !self::isOurRestRoute()) {
            return $result;
        }
        return null;
    }

    private static function isOurRestRoute(): bool
    {
        $wp = isset($GLOBALS['wp']) ? $GLOBALS['wp'] : null;
        $route = (is_object($wp) && isset($wp->query_vars['rest_route']) && is_string($wp->query_vars['rest_route'])) ? $wp->query_vars['rest_route'] : '';
        $prefix = '/' . Protocol::REST_NAMESPACE . '/';
        return strncasecmp($route, $prefix, strlen($prefix)) === 0;
    }

    /**
     * @param bool $served
     * @param mixed $result
     * @param mixed $request
     * @param mixed $server
     */
    public static function serveRest($served, $result, $request, $server): bool
    {
        if (self::$pending === null) {
            return (bool) $served;
        }
        $response = self::$pending;
        self::$pending = null;
        self::emit($response);
        return true;
    }

    public static function ping(): void
    {
        nocache_headers();
        header('Content-Type: text/plain; charset=utf-8');
        echo 'runova-pong';
        exit;
    }

    public static function serveAjax(): void
    {
        // Only ever compared against the fixed route list.
        $route = isset($_GET['route']) && is_string($_GET['route']) ? sanitize_text_field(wp_unslash($_GET['route'])) : '';
        $response = Plugin::dispatcher()->handle(self::incoming($route));
        self::emit($response);
        exit;
    }

    /** The current request's form fields and upload, for any entry point. */
    public static function incoming(string $route): IncomingRequest
    {
        // The value must then match Canonical::parseAuth's strict format; a valid one is unchanged here.
        $auth = isset($_POST[Protocol::AUTH_FIELD]) && is_string($_POST[Protocol::AUTH_FIELD])
            ? sanitize_text_field(wp_unslash($_POST[Protocol::AUTH_FIELD]))
            : null;
        $tooLarge = false;
        // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- only error and tmp_name are used, and tmp_name must pass is_uploaded_file().
        $upload = isset($_FILES[Protocol::BUNDLE_FIELD]) ? $_FILES[Protocol::BUNDLE_FIELD] : null;
        $bundle = UploadedBundle::fromUpload($upload, $tooLarge);
        // Past post_max_size PHP drops every field and file, so nothing is left but the length.
        $length = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
        $postMax = wp_convert_hr_to_bytes((string) ini_get('post_max_size'));
        if ($auth === null && $bundle === null && $postMax > 0 && $length > $postMax) {
            $tooLarge = true;
        }
        return new IncomingRequest($route, $auth, $bundle, ClientIp::get(), $tooLarge);
    }

    public static function emit(OutgoingResponse $response): void
    {
        // A buffer that cannot be discarded (zlib.output_compression) would loop forever.
        while (ob_get_level() > 0) {
            if (!@ob_end_clean()) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
                break;
            }
        }
        if (!headers_sent()) {
            status_header($response->status);
            nocache_headers();
            foreach ($response->headers as $name => $value) {
                header($name . ': ' . $value, true);
            }
        }
        echo $response->body; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- a binary envelope, not HTML.
    }
}
