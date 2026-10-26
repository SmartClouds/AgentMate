<?php
/**
 * Plugin options. On multisite the plugin is network-wide (themes and plugins are shared by every
 * site), so its options live in the network's options. On a single site they are never autoloaded.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Support;

final class Options
{
    /**
     * @param mixed $default
     * @return mixed
     */
    public static function get(string $name, $default = null)
    {
        return is_multisite() ? get_site_option($name, $default) : get_option($name, $default);
    }

    /**
     * Adds an option that does not exist yet. False when it already does.
     *
     * @param mixed $value
     */
    public static function add(string $name, $value): bool
    {
        if (is_multisite()) {
            return (bool) add_site_option($name, $value);
        }
        return (bool) add_option($name, $value, '', 'no');
    }

    /**
     * @param mixed $value
     */
    public static function update(string $name, $value): void
    {
        if (is_multisite()) {
            update_site_option($name, $value);
            return;
        }
        update_option($name, $value, false);
    }

    public static function delete(string $name): void
    {
        if (is_multisite()) {
            delete_site_option($name);
            return;
        }
        delete_option($name);
    }
}
