<?php
/**
 * An error that goes back to the client as a signed `{ok: false, error}` frame.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

use Runova\Connector\Protocol;

final class ApiError extends \Exception
{
    /** @var string */
    public $errorCode;

    /** @var int */
    public $status;

    /** @var array<string, mixed> */
    public $details;

    /** @var bool Counts toward the failed-auth rate limit and is written to the audit log. */
    public $authFailure;

    /**
     * @param array<string, mixed> $details
     */
    public function __construct(string $code, string $message, array $details = array(), ?int $status = null, bool $authFailure = false)
    {
        parent::__construct($message);
        $this->errorCode = $code;
        $this->details = $details;
        $this->status = $status === null ? Protocol::statusFor($code) : $status;
        $this->authFailure = $authFailure;
    }

    /**
     * An authentication failure: counted by the rate limiter and audited.
     *
     * @param array<string, mixed> $details
     */
    public static function auth(string $code, string $message, array $details = array()): self
    {
        return new self($code, $message, $details, null, true);
    }

    /**
     * @param array<string, mixed> $details
     */
    public static function badRequest(string $message, array $details = array()): self
    {
        return new self('badRequest', $message, $details);
    }
}
