<?php
/**
 * AdminContext from the logged-in WordPress user and the posted form.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Admin;

use Runova\Connector\Http\ClientIp;

final class WpAdminContext implements AdminContext
{
    public function can(string $capability): bool
    {
        return current_user_can($capability);
    }

    public function nonceOk(string $action): bool
    {
        if (!isset($_POST['_wpnonce']) || !is_string($_POST['_wpnonce'])) {
            return false;
        }
        return wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['_wpnonce'])), $action) !== false;
    }

    public function userId(): int
    {
        return (int) get_current_user_id();
    }

    public function ip(): string
    {
        return ClientIp::get();
    }

    public function multisite(): bool
    {
        return is_multisite();
    }
}
