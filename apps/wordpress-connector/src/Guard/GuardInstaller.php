<?php
/**
 * Puts the guard into the mu-plugins folder, with the connector's folder written into it, and
 * takes it out again on deactivation.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Guard;

final class GuardInstaller
{
    const FILE = '00-runova-connector-guard.php';
    const PLACEHOLDER = "\$runova_connector_dir = '';";
    const MARKER = 'Plugin Name: Runova Connector Guard';

    public static function path(): string
    {
        return self::muDir() . '/' . self::FILE;
    }

    private static function muDir(): string
    {
        return rtrim(WPMU_PLUGIN_DIR, '/\\');
    }

    /** The guard's source with this connector's folder filled in. */
    public static function render(string $pluginDir): string
    {
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- the plugin's own template.
        $template = (string) file_get_contents($pluginDir . '/guard/' . self::FILE);
        $line = '$runova_connector_dir = ' . var_export(rtrim($pluginDir, '/\\'), true) . ';';
        return str_replace(self::PLACEHOLDER, $line, $template);
    }

    public static function isCurrent(string $pluginDir): bool
    {
        return self::isCurrentAt(self::muDir(), $pluginDir);
    }

    public static function isCurrentAt(string $muDir, string $pluginDir): bool
    {
        $path = rtrim($muDir, '/\\') . '/' . self::FILE;
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
        return is_file($path) && file_get_contents($path) === self::render($pluginDir);
    }

    /** Writes the guard when it is missing or out of date. False when mu-plugins is not writable. */
    public static function install(string $pluginDir): bool
    {
        if (!is_dir(self::muDir()) && is_file($pluginDir . '/guard/' . self::FILE) && !wp_mkdir_p(self::muDir())) {
            return false;
        }
        return self::installAt(self::muDir(), $pluginDir);
    }

    /** install() for a given mu-plugins folder, which must exist. */
    public static function installAt(string $muDir, string $pluginDir): bool
    {
        $muDir = rtrim($muDir, '/\\');
        if (!is_file($pluginDir . '/guard/' . self::FILE) || !is_dir($muDir)) {
            return false;
        }
        $path = $muDir . '/' . self::FILE;
        $content = self::render($pluginDir);
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
        if (!is_file($path) || file_get_contents($path) !== $content) {
            if (is_file($path) && strpos((string) file_get_contents($path), self::MARKER) === false) { // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
                // Someone else's file under our name; leave it alone.
                return false;
            }
            return self::write($path, $content);
        }
        return true;
    }

    /** Writes through a temporary file and a rename, so the guard is never half written. */
    public static function write(string $path, string $content): bool
    {
        $temp = $path . '.' . bin2hex(random_bytes(4)) . '.tmp';
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
        if (@file_put_contents($temp, $content) === false) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            return false;
        }
        // phpcs:ignore WordPress.WP.AlternativeFunctions.rename_rename
        if (!@rename($temp, $path)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            @unlink($path); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            // phpcs:ignore WordPress.WP.AlternativeFunctions.rename_rename
            if (!@rename($temp, $path)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
                @unlink($temp); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
                return false;
            }
        }
        return true;
    }

    public static function uninstall(): void
    {
        $path = self::path();
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
        if (is_file($path) && strpos((string) file_get_contents($path), self::MARKER) !== false) {
            @unlink($path); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        }
    }
}
