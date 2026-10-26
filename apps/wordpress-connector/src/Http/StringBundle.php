<?php
/**
 * A bundle already in memory (tests, and the rescue path later on).
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

final class StringBundle implements Bundle
{
    /** @var string */
    private $bytes;

    public function __construct(string $bytes)
    {
        $this->bytes = $bytes;
    }

    public function size(): int
    {
        return strlen($this->bytes);
    }

    public function sha256(): string
    {
        return hash('sha256', $this->bytes);
    }

    public function read(int $maxBytes): ?string
    {
        return strlen($this->bytes) > $maxBytes ? null : $this->bytes;
    }
}
