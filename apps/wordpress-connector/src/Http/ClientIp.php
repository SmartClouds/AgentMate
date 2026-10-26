<?php
/**
 * The address failed-auth limits are counted against. REMOTE_ADDR by default; a site behind a
 * proxy it trusts can hand over the real client address with the
 * `runova_connector_client_ip` filter (or its old name, `agentmate_connector_client_ip`). // legacy-name
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

use Runova\Connector\Legacy;

final class ClientIp
{
    public static function get(): string
    {
        $ip = isset($_SERVER['REMOTE_ADDR']) ? sanitize_text_field(wp_unslash($_SERVER['REMOTE_ADDR'])) : '';
        $ip = (string) apply_filters(Legacy::CLIENT_IP_FILTER, $ip);
        $ip = (string) apply_filters('runova_connector_client_ip', $ip);
        return self::valid($ip);
    }

    public static function valid(string $ip): string
    {
        return filter_var($ip, FILTER_VALIDATE_IP) !== false ? $ip : 'unknown';
    }
}
