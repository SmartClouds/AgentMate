<?php
/**
 * The switches a site owner can set in wp-config.php. Each one is read under its Runova name and
 * under the name it had before the rename, so a wp-config.php written for 1.63 keeps working.
 * The Runova name wins when both are defined.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Support;

use Runova\Connector\Legacy;

final class Constants
{
    /** @var callable|null defined(name): bool and constant(name), for tests */
    private static $lookup = null;

    /** True when the switch is defined (under either name) and truthy. */
    public static function on(string $name): bool
    {
        $value = self::value($name);
        return $value !== null && (bool) $value;
    }

    /**
     * The switch's value, or null when it is not defined under either name.
     *
     * @return mixed
     */
    public static function value(string $name)
    {
        foreach (array($name, Legacy::constant($name)) as $candidate) {
            if ($candidate === null) {
                continue;
            }
            if (self::$lookup !== null) {
                $found = call_user_func(self::$lookup, $candidate);
                if ($found !== null) {
                    return $found;
                }
                continue;
            }
            if (defined($candidate)) {
                return constant($candidate);
            }
        }
        return null;
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
