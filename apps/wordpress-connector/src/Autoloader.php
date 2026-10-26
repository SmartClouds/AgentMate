<?php
/**
 * Loads the plugin's own classes. No Composer at runtime: the namespace maps straight onto src/.
 *
 * A class asked for under the namespace the plugin had before the rename gets the Runova class
 * under that name too. The 1.63 guard mu-plugin calls in by the old names, and it can stay in
 * mu-plugins for a while after the bridge update replaced the files it points at.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector;

final class Autoloader
{
    private const PREFIX = 'Runova\\Connector\\';

    /** @var string */
    private static $base = '';

    /** @var bool */
    private static $registered = false;

    public static function register(string $base): void
    {
        self::$base = rtrim($base, '/\\');
        if (self::$registered) {
            return;
        }
        self::$registered = true;
        spl_autoload_register(array(self::class, 'load'));
    }

    public static function load(string $class): void
    {
        $length = strlen(self::PREFIX);
        if (strncmp($class, self::PREFIX, $length) !== 0) {
            self::loadLegacy($class);
            return;
        }
        $relative = substr($class, $length);
        if (!preg_match('/^[A-Za-z0-9_\\\\]+$/D', $relative)) {
            return;
        }
        $file = self::$base . '/' . str_replace('\\', '/', $relative) . '.php';
        if (is_file($file)) {
            require_once $file;
        }
    }

    /** An old class name: load the Runova class and give it the old name as well. */
    private static function loadLegacy(string $class): void
    {
        $legacy = 'AgentMate\\Connector\\'; // legacy-name
        $length = strlen($legacy);
        if (strncmp($class, $legacy, $length) !== 0) {
            return;
        }
        $current = self::PREFIX . substr($class, $length);
        if (class_exists($current) || interface_exists($current)) {
            class_alias($current, $class);
        }
    }
}

// The 1.63 guard calls the autoloader by its old name before anything could load it that way.
if (!class_exists('AgentMate\\Connector\\Autoloader', false)) { // legacy-name
    class_alias(Autoloader::class, 'AgentMate\\Connector\\Autoloader'); // legacy-name
}
