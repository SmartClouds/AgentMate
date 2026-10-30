<?php
/**
 * The guard's single option. It always exists and is autoloaded, so reading it costs nothing on
 * a single site; it is an empty string unless a deploy is pending. On multisite it is a network
 * option, which WordPress reads with one small query per request when there is no object cache.
 *
 * Pending value: JSON {d: deploy id, t: deadline (Unix seconds), f: real paths of changed PHP files}.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Guard;


final class GuardState
{
    /** The guard mu-plugin reads it by this name on every request. */
    const OPTION = 'runova_connector_guard';

    /** Creates the option, empty and autoloaded, if it is missing. */
    public static function ensure(): void
    {
        if (is_multisite()) {
            if (get_site_option(self::OPTION, null) === null) {
                add_site_option(self::OPTION, '');
            }
            return;
        }
        add_option(self::OPTION, '', '', 'yes');
    }

    /**
     * @param array{d: string, t: int, f: string[]}|null $state
     */
    public static function write(?array $state): void
    {
        $value = $state === null ? '' : (string) json_encode($state, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (is_multisite()) {
            update_site_option(self::OPTION, $value);
            return;
        }
        update_option(self::OPTION, $value, true);
    }

    /**
     * Decodes a stored value. Null when no deploy is pending.
     *
     * @param mixed $raw
     * @return array{d: string, t: int, f: string[]}|null
     */
    public static function decode($raw): ?array
    {
        if (!is_string($raw) || $raw === '') {
            return null;
        }
        $data = json_decode($raw, true);
        if (!is_array($data) || !isset($data['d'], $data['t']) || !is_string($data['d'])) {
            return null;
        }
        $files = isset($data['f']) && is_array($data['f']) ? array_values(array_filter($data['f'], 'is_string')) : array();
        return array('d' => $data['d'], 't' => (int) $data['t'], 'f' => $files);
    }

    public static function delete(): void
    {
        if (is_multisite()) {
            delete_site_option(self::OPTION);
            return;
        }
        delete_option(self::OPTION);
    }
}
