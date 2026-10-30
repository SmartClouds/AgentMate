<?php
/**
 * The switches a site owner can set in wp-config.php.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Support;

final class Constants
{
    /** @var callable|null defined(name): bool and constant(name), for tests */
    private static $lookup = null;

    /** True when the switch is defined and truthy. */
    public static function on(string $name): bool
    {
        $value = self::value($name);
        return $value !== null && (bool) $value;
    }

    /**
     * The switch's value, or null when it is not defined.
     *
     * @return mixed
     */
    public static function value(string $name)
    {
        if (self::$lookup !== null) {
            return call_user_func(self::$lookup, $name);
        }
        return defined($name) ? constant($name) : null;
    }

    /**
     * Tests read constants from a map instead of define(), which cannot be undone.
     *
     * @param callable|null $lookup lookup(name): mixed, null when not defined
     */
    public static function useLookup(?callable $lookup): void
    {
        self::$lookup = $lookup;
    }
}
