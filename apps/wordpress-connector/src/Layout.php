<?php
/**
 * Which of the two layouts a copy of the plugin runs in:
 * - `runova`: wp-content/plugins/runova-connector/runova-connector.php, the normal one;
 * - `bridge`: the folder and main file 1.63 used, holding the Runova code. A 1.63 site updates
 *   itself to this package (its updater only takes that layout), and LayoutMigration then moves
 *   the site to the normal layout. The new main file waits in layout/ until then, one level down,
 *   so WordPress does not list a second plugin.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector;

final class Layout
{
    const RUNOVA = 'runova';
    const BRIDGE = 'bridge';

    const SLUG = 'runova-connector';
    const MAIN = 'runova-connector.php';
    const BASENAME = 'runova-connector/runova-connector.php';

    /** Where the bridge package keeps the main file of the normal layout. */
    const STAGED_MAIN = 'layout/runova-connector.php';

    /** The main file of the copy in $pluginDir. */
    public static function mainFile(string $pluginDir): string
    {
        $dir = rtrim($pluginDir, '/\\');
        if (!is_file($dir . '/' . self::MAIN) && is_file($dir . '/' . Legacy::MAIN)) {
            return $dir . '/' . Legacy::MAIN;
        }
        return $dir . '/' . self::MAIN;
    }

    public static function of(string $pluginDir): string
    {
        return basename(self::mainFile($pluginDir)) === Legacy::MAIN ? self::BRIDGE : self::RUNOVA;
    }

    /** The running copy's layout. */
    public static function current(): string
    {
        return defined('RUNOVA_CONNECTOR_FILE') && basename((string) RUNOVA_CONNECTOR_FILE) === Legacy::MAIN ? self::BRIDGE : self::RUNOVA;
    }

    /** The folder the other layout would live in, beside this one. */
    public static function otherDir(string $pluginDir): string
    {
        $dir = rtrim($pluginDir, '/\\');
        return dirname($dir) . '/' . (self::of($dir) === self::BRIDGE ? self::SLUG : Legacy::SLUG);
    }

    /** True when a copy of the connector in the other layout is on disk. */
    public static function otherExists(string $pluginDir): bool
    {
        $other = self::otherDir($pluginDir);
        return is_dir($other) && (is_file($other . '/' . self::MAIN) || is_file($other . '/' . Legacy::MAIN));
    }

    /** The plugin basename WordPress keeps in active_plugins for a layout. */
    public static function basename(string $layout): string
    {
        return $layout === self::BRIDGE ? Legacy::BASENAME : self::BASENAME;
    }
}
