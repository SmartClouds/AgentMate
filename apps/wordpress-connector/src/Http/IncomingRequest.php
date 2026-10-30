<?php
/**
 * One call as the transport received it, before anything about it is trusted.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

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

    public function __construct(string $route, ?string $auth, ?Bundle $bundle, string $ip, bool $bodyTooLarge = false)
    {
        $this->route = $route;
        $this->auth = $auth;
        $this->bundle = $bundle;
        $this->ip = $ip;
        $this->bodyTooLarge = $bodyTooLarge;
    }
}
