<?php
/**
 * Loads the plugin's own classes. No Composer at runtime: the namespace maps straight onto src/.
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
}
