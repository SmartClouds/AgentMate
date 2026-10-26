<?php
/**
 * Puts the guard into the mu-plugins folder, with the connector's folder written into it, and
 * takes it out again on deactivation. The guard 1.63 installed under the old file name is removed
 * once the new one is in place.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Guard;

use Runova\Connector\Legacy;

final class GuardInstaller
{
    const FILE = '00-runova-connector-guard.php';
    const PLACEHOLDER = "\$runova_connector_dir = '';";
    const MARKER = 'Plugin Name: Runova Connector Guard';

    public static function path(): string
    {
        return self::muDir() . '/' . self::FILE;
    }

    public static function legacyPath(): string
    {
        return self::muDir() . '/' . Legacy::GUARD_FILE;
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
        return is_file($path) && file_get_contents($path) === self::render($pluginDir) && !self::legacyIsOurs($muDir);
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
            if (!self::write($path, $content)) {
                return false;
            }
        }
        // The new guard runs first from now on; the old one would load the same classes again.
        return self::removeLegacyAt($muDir);
    }

    /**
     * Removes the guard 1.63 installed, when it is still there and still ours. False only when it
     * is there and could not be removed.
     */
    public static function removeLegacyAt(string $muDir): bool
    {
        $legacy = rtrim($muDir, '/\\') . '/' . Legacy::GUARD_FILE;
        if (!self::legacyIsOurs($muDir)) {
            return true;
        }
        @unlink($legacy); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        clearstatcache(true, $legacy);
        return !is_file($legacy);
    }

    /** The 1.63 guard is in mu-plugins (and is ours, not someone else's file under that name). */
    public static function legacyIsOurs(string $muDir): bool
    {
        $legacy = rtrim($muDir, '/\\') . '/' . Legacy::GUARD_FILE;
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
        return is_file($legacy) && strpos((string) file_get_contents($legacy), Legacy::GUARD_MARKER) !== false;
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
        self::removeLegacyAt(self::muDir());
    }
}
