<?php
/**
 * The real environment: answers come from WordPress. On multisite everything is read from the
 * main site, which is where the connection key's URLs point.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Env;

use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Layout;
use Runova\Connector\Legacy;
use Runova\Connector\Protocol;
use Runova\Connector\Support\Constants;
use Runova\Connector\Support\DataDir;

final class WordPressEnvironment implements Environment
{
    const GUARD_FILE = '00-runova-connector-guard.php';

    /** @var float */
    private $start;

    /** @var string|null */
    private $filesystemMethod = null;

    /** @var bool rescue.php: WordPress loaded with SHORTINIT, so nothing from wp-admin may be loaded */
    private $minimal;

    public function __construct(bool $minimal = false)
    {
        $this->start = isset($_SERVER['REQUEST_TIME_FLOAT']) ? (float) $_SERVER['REQUEST_TIME_FLOAT'] : microtime(true);
        $this->minimal = $minimal;
    }

    public function now(): int
    {
        return time();
    }

    public function elapsed(): float
    {
        return microtime(true) - $this->start;
    }

    public function pluginVersion(): string
    {
        return RUNOVA_CONNECTOR_VERSION;
    }

    public function layout(): string
    {
        return Layout::current();
    }

    private function mainSiteId(): ?int
    {
        return is_multisite() ? (int) get_main_site_id() : null;
    }

    /**
     * @return mixed
     */
    private function mainOption(string $name)
    {
        $main = $this->mainSiteId();
        if ($main !== null && $main !== (int) get_current_blog_id()) {
            return get_blog_option($main, $name);
        }
        return get_option($name);
    }

    public function siteName(): string
    {
        return wp_specialchars_decode((string) $this->mainOption('blogname'), ENT_QUOTES);
    }

    public function homeUrl(): string
    {
        return (string) get_home_url($this->mainSiteId());
    }

    public function siteUrl(): string
    {
        return (string) get_site_url($this->mainSiteId());
    }

    public function restUrl(): string
    {
        return (string) get_rest_url($this->mainSiteId(), Protocol::REST_NAMESPACE);
    }

    public function ajaxUrl(): string
    {
        return (string) get_admin_url($this->mainSiteId(), 'admin-ajax.php');
    }

    public function wpVersion(): string
    {
        return (string) get_bloginfo('version');
    }

    public function isMultisite(): bool
    {
        return is_multisite();
    }

    public function activeTheme(): array
    {
        return array(
            'stylesheet' => (string) $this->mainOption('stylesheet'),
            'template' => (string) $this->mainOption('template'),
        );
    }

    public function isHttps(): bool
    {
        if (function_exists('wp_is_using_https')) {
            return (bool) wp_is_using_https();
        }
        return strpos($this->homeUrl(), 'https://') === 0;
    }

    public function constantOn(string $name): bool
    {
        return Constants::on($name);
    }

    public function fileModsAllowed(): bool
    {
        return (bool) wp_is_file_mod_allowed('runova_connector');
    }

    public function filesystemMethod(): string
    {
        if ($this->filesystemMethod === null && $this->minimal) {
            // Only a rollback runs here, and a deploy could only have been applied with 'direct'.
            $this->filesystemMethod = defined('FS_METHOD') ? (string) FS_METHOD : 'direct';
        }
        if ($this->filesystemMethod === null) {
            if (!function_exists('get_filesystem_method')) {
                require_once ABSPATH . 'wp-admin/includes/file.php';
            }
            $this->filesystemMethod = (string) get_filesystem_method(array(), WP_CONTENT_DIR, false);
        }
        return $this->filesystemMethod;
    }

    public function iniGet(string $name): string
    {
        $value = ini_get($name);
        return is_string($value) ? $value : '';
    }

    public function memoryUsage(): int
    {
        return memory_get_usage();
    }

    public function itemRoot(string $kind): string
    {
        if ($kind === 'theme') {
            return untrailingslashit((string) get_theme_root());
        }
        if ($kind === 'plugin') {
            return untrailingslashit(WP_PLUGIN_DIR);
        }
        return untrailingslashit(WPMU_PLUGIN_DIR);
    }

    public function themes(): array
    {
        $root = $this->itemRoot('theme');
        $out = array();
        foreach (wp_get_themes() as $stylesheet => $theme) {
            if (untrailingslashit((string) $theme->get_theme_root()) !== $root) {
                continue;
            }
            $template = (string) $theme->get_template();
            $out[] = array(
                'slug' => (string) $stylesheet,
                'name' => (string) $theme->get('Name'),
                'version' => (string) $theme->get('Version'),
                'parent' => $template !== '' && $template !== (string) $stylesheet ? $template : null,
            );
        }
        return $out;
    }

    private function loadPluginFunctions(): void
    {
        if (!function_exists('get_plugins')) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }
    }

    public function plugins(): array
    {
        $this->loadPluginFunctions();
        return get_plugins();
    }

    public function muPlugins(): array
    {
        $this->loadPluginFunctions();
        return get_mu_plugins();
    }

    public function activePlugins(): array
    {
        $active = $this->mainOption('active_plugins');
        $active = is_array($active) ? array_values(array_filter($active, 'is_string')) : array();
        return array_values(array_unique(array_merge($active, $this->networkActivePlugins())));
    }

    public function networkActivePlugins(): array
    {
        if (!is_multisite()) {
            return array();
        }
        $network = get_site_option('active_sitewide_plugins', array());
        return is_array($network) ? array_map('strval', array_keys($network)) : array();
    }

    public function connectorSlug(): string
    {
        return dirname(plugin_basename(RUNOVA_CONNECTOR_FILE));
    }

    public function guardSlug(): string
    {
        return self::GUARD_FILE;
    }

    public function dataDir(): string
    {
        return DataDir::path();
    }

    /** rescue.php's URL, only when it is on the site's own origin (not a CDN host for plugin files). */
    public function rescueUrl(): ?string
    {
        return $this->rescueUrlFor(RUNOVA_CONNECTOR_FILE);
    }

    /** rescue.php beside a main file, for a copy of the connector that may not be the running one. */
    public function rescueUrlFor(string $mainFile): ?string
    {
        if (!is_file(dirname($mainFile) . '/rescue.php')) {
            return null;
        }
        $url = (string) plugins_url('rescue.php', $mainFile);
        $origin = self::origin($url);
        if ($origin === null) {
            return null;
        }
        foreach (array($this->siteUrl(), $this->homeUrl()) as $site) {
            if (self::origin($site) === $origin) {
                return $url;
            }
        }
        return null;
    }

    private static function origin(string $url): ?string
    {
        $parts = wp_parse_url($url);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])) {
            return null;
        }
        $scheme = strtolower($parts['scheme']);
        $port = isset($parts['port']) ? (int) $parts['port'] : ($scheme === 'https' ? 443 : 80);
        return $scheme . '://' . strtolower($parts['host']) . ':' . $port;
    }

    public function sodiumMode(): string
    {
        return Crypto::sodiumMode();
    }

    public function confirmSeconds(): int
    {
        return self::confirmWindow();
    }

    /** RUNOVA_CONNECTOR_CONFIRM_SECONDS shortens the window for tests; never below 5 or above 180. */
    public static function confirmWindow(): int
    {
        $seconds = Constants::value('RUNOVA_CONNECTOR_CONFIRM_SECONDS');
        if (is_numeric($seconds)) {
            return (int) max(5, min(180, (int) $seconds));
        }
        return 180;
    }

    public function healthChecks(): array
    {
        $this->cleanCaches();
        $home = add_query_arg('runova_health', bin2hex(random_bytes(6)), get_home_url($this->mainSiteId(), '/'));
        $ping = add_query_arg(
            array('action' => Protocol::AJAX_ACTION . '_ping', 'runova_health' => bin2hex(random_bytes(6))),
            $this->ajaxUrl()
        );
        return array(self::probe('home', $home, null), self::probe('ajaxPing', $ping, 'runova-pong'));
    }

    /**
     * @return array{name: string, status: int|null, ok: bool|null, detail: string}
     */
    private static function probe(string $name, string $url, ?string $expect): array
    {
        $response = wp_remote_get($url, array(
            'timeout' => 10,
            'redirection' => 0,
            'sslverify' => (bool) apply_filters('https_local_ssl_verify', false),
            'headers' => array('Cache-Control' => 'no-cache'),
            'cookies' => array(),
        ));
        if (is_wp_error($response)) {
            return array('name' => $name, 'status' => null, 'ok' => null, 'detail' => 'The site could not reach itself: ' . $response->get_error_message());
        }
        $status = (int) wp_remote_retrieve_response_code($response);
        $detail = 'HTTP ' . $status;
        if ($status === 401 || $status === 403) {
            // A staging site behind a sign-in: alive, but nothing can be judged.
            return array('name' => $name, 'status' => $status, 'ok' => null, 'detail' => $detail . ', the site asks for a sign-in');
        }
        if ($expect !== null) {
            $ok = $status === 200 && strpos((string) wp_remote_retrieve_body($response), $expect) !== false;
        } else {
            // Redirects and client errors still mean PHP got through the request.
            $ok = $status > 0 && $status < 500;
        }
        return array('name' => $name, 'status' => $status, 'ok' => $ok, 'detail' => $detail);
    }

    public function download(string $url, int $maxBytes, int $timeoutSeconds): array
    {
        if ($this->minimal || !function_exists('wp_safe_remote_get')) {
            return array('body' => null, 'error' => 'WordPress\'s HTTP functions are not loaded');
        }
        // The swap and its health checks still have to fit in the request after the download.
        if (function_exists('set_time_limit')) {
            @set_time_limit($timeoutSeconds + 90); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        }
        $response = wp_safe_remote_get($url, array(
            'timeout' => $timeoutSeconds,
            'redirection' => 5,
            'limit_response_size' => $maxBytes + 1,
            'headers' => array('Accept' => 'application/octet-stream'),
        ));
        if (is_wp_error($response)) {
            return array('body' => null, 'error' => $response->get_error_message());
        }
        $status = (int) wp_remote_retrieve_response_code($response);
        if ($status !== 200) {
            return array('body' => null, 'error' => 'GitHub answered HTTP ' . $status);
        }
        $body = (string) wp_remote_retrieve_body($response);
        if (strlen($body) > $maxBytes) {
            return array('body' => null, 'error' => 'the file is larger than a connector can be');
        }
        return array('body' => $body, 'error' => '');
    }

    public function invalidateOpcache(string $path): void
    {
        if ($this->minimal) {
            if (function_exists('opcache_invalidate')) {
                @opcache_invalidate($path, true); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            }
            return;
        }
        if (!function_exists('wp_opcache_invalidate') && is_file(ABSPATH . 'wp-admin/includes/file.php')) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
        }
        if (function_exists('wp_opcache_invalidate')) {
            wp_opcache_invalidate($path, true);
        } elseif (function_exists('opcache_invalidate')) {
            @opcache_invalidate($path, true); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        }
    }

    public function cleanCaches(): void
    {
        if ($this->minimal) {
            // The caches are rebuilt on the next full page load anyway.
            return;
        }
        if (function_exists('wp_clean_themes_cache')) {
            wp_clean_themes_cache();
        }
        $this->loadPluginFunctions();
        if (function_exists('wp_clean_plugins_cache')) {
            wp_clean_plugins_cache();
        }
    }

    public function setGuardState(?array $state): void
    {
        \Runova\Connector\Guard\GuardState::write($state);
    }

    public function fileMode(): int
    {
        return defined('FS_CHMOD_FILE') ? (int) FS_CHMOD_FILE : 0644;
    }

    public function dirMode(): int
    {
        return defined('FS_CHMOD_DIR') ? (int) FS_CHMOD_DIR : 0755;
    }
}
