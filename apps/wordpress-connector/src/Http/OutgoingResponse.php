<?php
/**
 * The bytes and headers to send back. Always an envelope; the transport only copies it out.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

final class OutgoingResponse
{
    /** @var int */
    public $status;

    /** @var string */
    public $body;

    /** @var array<string, string> */
    public $headers;

    /**
     * @param array<string, string> $headers
     */
    public function __construct(int $status, string $body, array $headers = array())
    {
        $this->status = $status;
        $this->body = $body;
        $this->headers = array_merge(
            array(
                'Content-Type' => 'application/octet-stream',
                'Cache-Control' => 'no-store, private',
                'X-LiteSpeed-Cache-Control' => 'no-cache',
                'X-Content-Type-Options' => 'nosniff',
                'X-Robots-Tag' => 'noindex',
            ),
            $headers
        );
    }
}
