<?php
/**
 * A verified request, as handlers see it.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Routes;

use Runova\Connector\Http\Frame;

final class RequestContext
{
    /** @var string */
    public $route;

    /** @var mixed the frame's `b` */
    public $body;

    /** @var Frame */
    public $frame;

    /** @var array<string, mixed> the connection row */
    public $connection;

    /** @var string */
    public $ip;

    /** @var int */
    public $now;

    /**
     * @param array<string, mixed> $connection
     */
    public function __construct(string $route, Frame $frame, array $connection, string $ip, int $now)
    {
        $this->route = $route;
        $this->frame = $frame;
        $this->body = $frame->body;
        $this->connection = $connection;
        $this->ip = $ip;
        $this->now = $now;
    }

    /**
     * A field of an object body, or $default.
     *
     * @param mixed $default
     * @return mixed
     */
    public function field(string $name, $default = null)
    {
        return is_array($this->body) && array_key_exists($name, $this->body) ? $this->body[$name] : $default;
    }
}
