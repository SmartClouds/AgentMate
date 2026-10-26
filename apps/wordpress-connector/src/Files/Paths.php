<?php
/**
 * Filesystem path comparisons that hold on Windows hosts too (backslashes, case-insensitive).
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Files;

final class Paths
{
    public static function normalize(string $path): string
    {
        if (DIRECTORY_SEPARATOR === '\\') {
            return strtolower(str_replace('\\', '/', $path));
        }
        return $path;
    }

    public static function same(string $a, string $b): bool
    {
        return self::normalize($a) === self::normalize($b);
    }

    /** True when $child is strictly inside $parent. */
    public static function inside(string $child, string $parent): bool
    {
        $parent = rtrim(self::normalize($parent), '/') . '/';
        return strpos(self::normalize($child), $parent) === 0;
    }

    /** The real path when nothing on the way is a symlink and it stays where it claims to be. */
    public static function containedReal(string $path, string $expected): ?string
    {
        $real = realpath($path);
        if (!is_string($real)) {
            return null;
        }
        return self::same($real, $expected) ? $real : null;
    }

    /**
     * Orders paths the way the manifest walk visits them: segment by segment, byte-wise, a folder
     * before what is inside it. Plain strcmp would put "a.txt" before "a/x".
     */
    public static function compare(string $a, string $b): int
    {
        $left = explode('/', $a);
        $right = explode('/', $b);
        $count = min(count($left), count($right));
        for ($index = 0; $index < $count; $index++) {
            $order = strcmp($left[$index], $right[$index]);
            if ($order !== 0) {
                return $order < 0 ? -1 : 1;
            }
        }
        return count($left) <=> count($right);
    }

    /** True when $path is inside the folder $ancestor (both relative, `/`-separated). */
    public static function isAncestor(string $ancestor, string $path): bool
    {
        return strncmp($path, $ancestor . '/', strlen($ancestor) + 1) === 0;
    }
}
