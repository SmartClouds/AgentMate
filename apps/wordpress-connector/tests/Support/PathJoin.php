<?php
/**
 * Where an item's file lives under the fake wp-content.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Support;

final class PathJoin
{
    public static function item(string $root, string $slug, string $path): string
    {
        // A single-file item's only path is its own name.
        return $path === $slug && substr($slug, -4) === '.php' ? $root . '/' . $slug : $root . '/' . $slug . '/' . $path;
    }
}
