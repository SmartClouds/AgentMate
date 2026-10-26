<?php
/**
 * One call as the transport received it, before anything about it is trusted.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

use Runova\Connector\Protocol;

final class IncomingRequest
{
    /** @var string The route the URL asked for (REST path or the ajax `route` parameter). */
    public $route;

    /** @var string|null The am_auth field, unslashed. */
    public $auth;

    /** @var Bundle|null */
    public $bundle;

    /** @var bool PHP refused the body or the upload for its size. */
    public $bodyTooLarge;

    /** @var string */
    public $ip;

    /**
     * @var string The signing prefix the endpoint suggests: the old one for the namespace and
     *      action 1.63 desktops call. A signed request is checked against both prefixes anyway;
     *      this one signs replies to requests that never verified, such as /hello.
     */
    public $prefix;

    public function __construct(string $route, ?string $auth, ?Bundle $bundle, string $ip, bool $bodyTooLarge = false, string $prefix = Protocol::PREFIX)
    {
        $this->route = $route;
        $this->auth = $auth;
        $this->bundle = $bundle;
        $this->ip = $ip;
        $this->bodyTooLarge = $bodyTooLarge;
        $this->prefix = $prefix;
    }
}
