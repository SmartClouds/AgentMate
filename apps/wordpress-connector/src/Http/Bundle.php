<?php
/**
 * The `bundle` part of a request: gzip of a frame. Its size and hash are known before any of it
 * is read into memory.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

interface Bundle
{
    public function size(): int;

    /** Lowercase hex SHA-256 of the bytes exactly as sent. */
    public function sha256(): string;

    /** The bytes, or null when there are more than $maxBytes of them or they cannot be read. */
    public function read(int $maxBytes): ?string;
}
