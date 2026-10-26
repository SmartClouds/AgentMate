<?php
/**
 * An AdminContext with settable capabilities and nonces.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Support;

use Runova\Connector\Admin\AdminContext;

final class FakeAdminContext implements AdminContext
{
    /** @var string[] */
    public $capabilities = array('manage_options', 'install_plugins', 'install_themes');

    /** @var string[] nonce actions the posted form is valid for */
    public $nonces = array();

    /** @var bool */
    public $multisite = false;

    public function can(string $capability): bool
    {
        return in_array($capability, $this->capabilities, true);
    }

    public function nonceOk(string $action): bool
    {
        return in_array($action, $this->nonces, true);
    }

    public function userId(): int
    {
        return 3;
    }

    public function ip(): string
    {
        return '198.51.100.7';
    }

    public function multisite(): bool
    {
        return $this->multisite;
    }
}
